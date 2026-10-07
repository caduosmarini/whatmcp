-- Only searchable windows/vectors invalidate the cached vector matrix.
CREATE TABLE search_index_state(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL);
INSERT INTO search_index_state VALUES(1,0);
CREATE TRIGGER bump_search_windows_insert AFTER INSERT ON windows
BEGIN UPDATE search_index_state SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER bump_search_windows_update AFTER UPDATE ON windows
BEGIN UPDATE search_index_state SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER bump_search_windows_delete AFTER DELETE ON windows
BEGIN UPDATE search_index_state SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER bump_search_window_vectors_insert AFTER INSERT ON window_vectors
BEGIN UPDATE search_index_state SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER bump_search_window_vectors_update AFTER UPDATE ON window_vectors
BEGIN UPDATE search_index_state SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER bump_search_window_vectors_delete AFTER DELETE ON window_vectors
BEGIN UPDATE search_index_state SET generation=generation+1 WHERE id=1; END;
