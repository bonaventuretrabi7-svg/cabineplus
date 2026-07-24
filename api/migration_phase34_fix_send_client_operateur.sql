-- Phase 34 -- corrige retroactivement les transactions de transfert
-- client-a-client deja enregistrees avec l'ancien texte technique
-- "send-client" comme operateur (voir client_transfer.php, corrige pour
-- stocker desormais le vrai reseau du numero beneficiaire de chaque
-- ligne -- meme regle que phoneNetwork(), api/bootstrap.php). Cette
-- migration ne touche que les lignes deja figees en base avant ce
-- correctif ; les nouveaux transferts stockent deja le bon reseau des
-- leur creation, rien a faire pour eux. A coller UNE SEULE FOIS dans
-- phpMyAdmin (onglet SQL) sur la base deja en place.

UPDATE transactions
SET operateur = CASE
  WHEN numero_beneficiaire LIKE '07%' THEN 'Orange'
  WHEN numero_beneficiaire LIKE '05%' THEN 'MTN'
  WHEN numero_beneficiaire LIKE '01%' THEN 'Moov'
  ELSE 'Autre'
END
WHERE operateur = 'send-client';
