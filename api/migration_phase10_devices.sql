-- Phase 10 (mise en conformite temps reel, phase G/9) -- appareils
-- connectes, jusqu'ici 100% locaux (localStorage, jamais visibles ni
-- revocables depuis un AUTRE appareil). A coller UNE SEULE FOIS dans
-- phpMyAdmin (onglet SQL) sur la base deja en place.

CREATE TABLE IF NOT EXISTS devices (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  profile_id   CHAR(36)     NOT NULL,
  device_id    CHAR(36)     NOT NULL,
  label        VARCHAR(190) NULL,
  token_hash   CHAR(64)     NULL,
  remembered   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_profile_device (profile_id, device_id),
  KEY idx_devices_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
