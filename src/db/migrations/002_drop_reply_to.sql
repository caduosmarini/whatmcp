-- Remove messages.reply_to.
--
-- It was captured from ZWAMESSAGE.ZPARENTMESSAGE, stored, and surfaced by no
-- tool. Worse, it was populated zero times across 80,469 archived messages: the
-- join never matched on this WhatsApp build, so the column was not merely unused
-- but permanently NULL.
--
-- A column that is always NULL is worse than an absent one. It reads like data
-- that exists, so the next person to want reply threading finds the field, sees
-- it empty, and concludes the user simply never replies to messages — rather
-- than that the extraction never worked. Deleting it makes the absence honest.
--
-- If reply threading is wanted later, it needs a working source first. That means
-- establishing which column actually carries the parent reference on current
-- WhatsApp builds (ZWAMESSAGEINFO and ZWAMESSAGEDATAITEM are the candidates),
-- verified against a store where replies are known to exist.

ALTER TABLE messages DROP COLUMN reply_to;
