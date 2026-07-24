-- Phase 35 -- corrige retroactivement les recharges de portefeuille deja
-- enregistrees avec l'ancien texte technique "Auto recharge" comme
-- operateur ET numero_beneficiaire (voir orders_recharge.php, corrige
-- pour stocker desormais le vrai reseau et le numero du client qui se
-- recharge lui-meme -- meme regle que phoneNetwork(), api/bootstrap.php).
-- Cette migration ne touche que les lignes deja figees en base avant ce
-- correctif ; les nouvelles recharges stockent deja le bon reseau/numero
-- des leur creation, rien a faire pour elles. A coller UNE SEULE FOIS
-- dans phpMyAdmin (onglet SQL) sur la base deja en place.

UPDATE transactions t
JOIN profiles p ON p.id = t.client_id
SET t.operateur = CASE
    WHEN p.telephone LIKE '07%' THEN 'Orange'
    WHEN p.telephone LIKE '05%' THEN 'MTN'
    WHEN p.telephone LIKE '01%' THEN 'Moov'
    ELSE 'Autre'
  END,
  t.numero_beneficiaire = p.telephone
WHERE t.operateur = 'Auto recharge' AND t.type = 'recharge';
