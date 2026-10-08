#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, ChildStdout, Command, Stdio}, sync::{Arc, Mutex}, time::Duration};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

struct Backend { mode:String, root:PathBuf, child: Child, input: ChildStdin, output: BufReader<ChildStdout> }
impl Backend {
    fn ask(&mut self, method: &str, params: Value) -> Result<Value,String> {
        let payload=serde_json::to_vec(&json!({"method":method,"params":params})).map_err(|e|e.to_string())?;
        if payload.len()>65536 { return Err("Request too large".into()) }
        self.input.write_all(&payload).and_then(|_|self.input.write_all(b"\n")).and_then(|_|self.input.flush()).map_err(|e|e.to_string())?;
        let mut line=String::new();if self.output.read_line(&mut line).map_err(|e|e.to_string())?==0{return Err("Archive runtime stopped; restart the app".into())}
        let reply:Value=serde_json::from_str(&line).map_err(|e|e.to_string())?;
        if reply["ok"]==true {Ok(reply["result"].clone())}else{Err(reply["error"].as_str().unwrap_or("Archive command failed").into())}
    }
    fn stop(&mut self){let _=self.ask("shutdown",json!({}));let _=self.child.kill();let _=self.child.wait();}
}
struct Desktop { backend:Mutex<Option<Backend>>, resources:PathBuf, data:PathBuf, source_home:String, updating:Mutex<bool> }
type Shared=Arc<Desktop>;
fn spawn_backend(state:&Desktop,mode:&str,root:&Path)->Result<Backend,String>{
    std::fs::create_dir_all(state.data.join("runtime-home/tmp")).map_err(|e|e.to_string())?;
    let bin=state.resources.join("bin");let runtime=state.resources.join("runtime");
    let mut cmd=Command::new(bin.join(if cfg!(windows){"node.exe"}else{"node"}));
    cmd.args(["--experimental-sqlite","--experimental-strip-types","--no-warnings"]).arg(runtime.join("src/desktop/server.ts"));
    // Drop inherited WHATMCP/API overrides. Only the explicitly selected profile applies.
    for (key,_) in std::env::vars(){if key.starts_with("WHATMCP_")||["OPENAI_API_KEY","NODE_OPTIONS","NODE_PATH"].contains(&key.as_str()){cmd.env_remove(key);}}
    cmd.env("WHATMCP_HOME",root).env("WHATMCP_DESKTOP_MODE",mode)
       .env("HOME",state.data.join("runtime-home")).env("USERPROFILE",state.data.join("runtime-home")).env("TMPDIR",state.data.join("runtime-home/tmp"))
       .env("TMP",state.data.join("runtime-home/tmp")).env("TEMP",state.data.join("runtime-home/tmp"))
       .env("WHATMCP_USER_HOME",&state.source_home).env("WHATMCP_COLLECTOR",bin.join("macos-collector"))
       .env("WHATMCP_APPLE_BINARY",bin.join("apple-transcribe"));
    #[cfg(windows)] {use std::os::windows::process::CommandExt;cmd.creation_flags(0x08000000);}
    let mut child=cmd.current_dir(&runtime).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e|format!("Cannot start bundled archive runtime: {e}"))?;
    Ok(Backend{mode:mode.into(),root:root.into(),input:child.stdin.take().ok_or("Missing runtime input")?,output:BufReader::new(child.stdout.take().ok_or("Missing runtime output")?),child})
}
fn overview(state:&Desktop)->Result<Value,String>{state.backend.lock().map_err(|_|"Runtime unavailable")?.as_mut().ok_or("Runtime unavailable")?.ask("overview",json!({}))}
#[tauri::command]
async fn archive_call(state:tauri::State<'_,Shared>,method:String,params:Value)->Result<Value,String>{
    let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{let flag=state.updating.lock().map_err(|_|"Update unavailable")?;if *flag{return Err("An app update is in progress".into())}state.backend.lock().map_err(|_|"Runtime unavailable")?.as_mut().ok_or("Runtime unavailable")?.ask(&method,params)}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn switch_profile(state:tauri::State<'_,Shared>,mode:String,folder:Option<String>)->Result<Value,String>{
    if !["demo","archive","existing"].contains(&mode.as_str()){return Err("Unknown profile".into())}
    let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{
        let flag=state.updating.lock().map_err(|_|"Update unavailable")?;if *flag {return Err("Update in progress".into())}
        let mut backend=state.backend.lock().map_err(|_|"Runtime unavailable")?;
        if let Some(current)=backend.as_mut(){let status=current.ask("overview",json!({}))?;if status["jobs"].as_array().map(|a|a.iter().any(|j|j["state"]=="running")).unwrap_or(false){return Err("Finish or cancel the current job before switching profiles".into())}}
        let root=if mode=="existing"{let path=PathBuf::from(folder.ok_or("Select a profile folder")?);if !path.is_absolute()||!path.join("config.json").is_file(){return Err("Select an existing WhatMCP folder containing config.json".into())}path.canonicalize().map_err(|e|e.to_string())?}else{let path=state.data.join("profiles").join(&mode);std::fs::create_dir_all(&path).map_err(|e|e.to_string())?;path};
        // Probe the new runtime before replacing the current one; no migrations for existing.
        let mut next=spawn_backend(&state,&mode,&root)?;let info=match next.ask("overview",json!({})){Ok(v)=>v,Err(e)=>{next.stop();return Err(e)}};
        if let Some(old)=backend.as_mut(){old.stop()}*backend=Some(next);Ok(info)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn open_fda_settings()->Result<(),String>{
    #[cfg(target_os="macos")] {Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles").spawn().map_err(|e|e.to_string())?;return Ok(())}
    #[cfg(not(target_os="macos"))] {Err("Full Disk Access is a macOS setting".into())}
}
#[tauri::command]
fn update_info()->Value {json!({"configured":!option_env!("TAURI_UPDATER_PUBLIC_KEY").unwrap_or("").is_empty(),"version":env!("CARGO_PKG_VERSION")})}
fn updater(app:&tauri::AppHandle)->Result<tauri_plugin_updater::Updater,String>{
    let key=option_env!("TAURI_UPDATER_PUBLIC_KEY").unwrap_or("");if key.is_empty(){return Err("Updates are not activated in this development build; release signing setup is pending".into())}
    app.updater_builder().pubkey(key).timeout(Duration::from_secs(30)).build().map_err(|e|e.to_string())
}
#[tauri::command]
async fn check_update(app:tauri::AppHandle)->Result<Value,String>{match updater(&app)?.check().await.map_err(|e|e.to_string())?{Some(u)=>Ok(json!({"version":u.version,"notes":u.body,"date":u.date.map(|d|d.to_string())})),None=>Ok(Value::Null)}}
#[tauri::command]
async fn install_update(app:tauri::AppHandle,state:tauri::State<'_,Shared>,version:String)->Result<(),String>{
    let state=state.inner().clone();{
        let mut flag=state.updating.lock().map_err(|_|"Update unavailable")?;if *flag{return Err("Update already running".into())}
        let status=overview(&state)?;if status["jobs"].as_array().map(|a|a.iter().any(|j|j["state"]=="running")).unwrap_or(false){return Err("Finish or cancel sync/transcription before updating".into())}*flag=true;
    }
    let result=async{
        let update=updater(&app)?.check().await.map_err(|e|e.to_string())?.ok_or("No update available")?;
        if update.version!=version{return Err("Available update changed; check again".into())}
        let progress_app=app.clone();let mut downloaded=0u64;
        let bytes=update.download(move |chunk,total|{downloaded+=chunk as u64;let _=progress_app.emit("update-progress",json!({"downloaded":downloaded,"total":total}));},||{}).await.map_err(|e|e.to_string())?;
        // Close our readers/workers before replacing binaries. User archives live outside the bundle.
        let mut runtime=state.backend.lock().map_err(|_|"Runtime unavailable")?;
        let profile=runtime.as_ref().map(|r|(r.mode.clone(),r.root.clone()));
        if let Some(current)=runtime.as_mut(){current.stop()}
        if let Err(error)=update.install(bytes){if let Some((mode,root))=profile{*runtime=Some(spawn_backend(&state,&mode,&root)?)}return Err(error.to_string())}drop(runtime);app.restart();
        #[allow(unreachable_code)] Ok(())
    }.await;
    if let Ok(mut flag)=state.updating.lock(){*flag=false}result
}
fn main(){
    tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app,_,_|{if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}}))
    .plugin(tauri_plugin_updater::Builder::new().build()).setup(|app|{
        let resources=if cfg!(debug_assertions){PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")}else{app.path().resource_dir()?};
        let data=std::env::var_os("WHATMCP_DESKTOP_DATA").map(PathBuf::from).unwrap_or(app.path().app_data_dir()?);
        let source_home=std::env::var("HOME").or_else(|_|std::env::var("USERPROFILE")).unwrap_or_default();
        let state=Arc::new(Desktop{backend:Mutex::new(None),resources,data,source_home,updating:Mutex::new(false)});
        let root=state.data.join("profiles/demo");std::fs::create_dir_all(&root)?;let backend=spawn_backend(&state,"demo",&root).map_err(std::io::Error::other)?;
        *state.backend.lock().unwrap()=Some(backend);app.manage(state);Ok(())
    }).invoke_handler(tauri::generate_handler![archive_call,switch_profile,open_fda_settings,update_info,check_update,install_update])
    .build(tauri::generate_context!()).expect("Unable to initialize WhatMCP").run(|app,event|{if matches!(event,tauri::RunEvent::Exit){let state=app.state::<Shared>();if let Ok(mut runtime)=state.backend.lock(){if let Some(runtime)=runtime.as_mut(){runtime.stop()}};}});
}
