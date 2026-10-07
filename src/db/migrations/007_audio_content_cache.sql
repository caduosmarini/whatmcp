ALTER TABLE audio_media ADD COLUMN hash_verified_at INTEGER;
CREATE INDEX idx_transcript_content ON audio_transcripts(audio_sha256,model,model_revision,locale,status);
