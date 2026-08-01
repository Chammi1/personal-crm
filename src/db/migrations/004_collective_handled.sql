-- Закрытие наступлений коллективных событий: как handled_for у обычных.
ALTER TABLE collective_event ADD COLUMN handled_for TEXT;
