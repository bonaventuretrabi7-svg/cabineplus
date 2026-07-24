<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Valide une candidature partenaire et crée le compte cabine — remplace
// validatePartnerRequest() (js/admin.js). Le hash du PIN a déjà été
// calculé à la création de la candidature (partner_applications_create.php) :
// insertion directe dans profiles avec ce hash, jamais de PIN en clair à
// aucun moment de ce flux (contrairement à l'ancienne version locale, qui
// transmettait app.pin en clair à ServerAPI.createAccount()).
$me = requireAuth(['admin']);

$in = body();
$id = (string)($in['application_id'] ?? '');
if ($id === '') fail('Identifiant de candidature requis.');

$pdo = db();
$pdo->beginTransaction();
try {
  $stmt = $pdo->prepare("SELECT * FROM partner_applications WHERE id = ? AND statut = 'en_attente' FOR UPDATE");
  $stmt->execute([$id]);
  $app = $stmt->fetch();
  if (!$app) {
    $pdo->rollBack();
    fail('Candidature introuvable ou déjà traitée.');
  }

  $dupStmt = $pdo->prepare("SELECT id FROM profiles WHERE telephone = ? AND role = 'cabine'");
  $dupStmt->execute([$app['telephone']]);
  if ($dupStmt->fetch()) {
    $pdo->rollBack();
    fail('Ce numéro est déjà utilisé par un autre compte cabine.');
  }

  // Même contrôle pour l'email : profiles a une contrainte unique
  // (telephone, role) ET (email, role) -- sans cette vérification, la
  // validation échouait avec une erreur SQL brute (non explicite) dès
  // qu'un compte cabine existait déjà avec cet email.
  if ($app['email'] !== '' && $app['email'] !== null) {
    $dupEmailStmt = $pdo->prepare("SELECT id FROM profiles WHERE LOWER(email) = LOWER(?) AND role = 'cabine'");
    $dupEmailStmt->execute([$app['email']]);
    if ($dupEmailStmt->fetch()) {
      $pdo->rollBack();
      fail('Cet email est déjà utilisé par un autre compte cabine.');
    }
  }

  $cabineId = uuid4();
  // docs : reprend la pièce d'identité (recto/verso) fournie à la
  // candidature — sans quoi elle disparaissait dès la validation, alors
  // que profiles.docs existe déjà pour ça (voir admin_update_profile.php).
  $docs = ($app['piece_recto'] || $app['piece_verso'])
    ? json_encode(['cni_recto' => $app['piece_recto'], 'cni_verso' => $app['piece_verso']])
    : null;
  // abonnement_debut : amorce le délai de 30 jours pour atteindre le
  // quota (voir checkQuotaDeadline(), api/orders_common.php).
  $pdo->prepare('INSERT INTO profiles
      (id, role, nom, prenom, telephone, email, mot_de_passe_hash, cabine_nom, solde, statut, abonnement, abonnement_debut,
       whatsapp, photo, docs, code_qr, motivation, experience, puces, paiement_abo, paiement_vers, numero_compte)
      VALUES (?, \'cabine\', ?, ?, ?, ?, ?, ?, 0, \'actif\', ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      ->execute([
        $cabineId, $app['nom'], $app['prenom'], $app['telephone'], $app['email'], $app['mot_de_passe_hash'],
        $app['cabine_nom'], $app['abonnement'] ?: 'Premium', $app['whatsapp'], $app['photo'], $docs, $app['code_qr'],
        $app['motivation'], $app['experience'], $app['puces'], $app['paiement_abo'], $app['paiement_vers'],
        $app['numero_compte'],
      ]);

  $pdo->prepare("UPDATE partner_applications SET statut = 'validée', date_traitement = NOW(), processed_by = ? WHERE id = ?")
      ->execute([$me['id'], $id]);

  // Parrainage (facultatif, voir _parseParrainCode()/prgSubmit(),
  // js/client.js) : 1 000 F crédités au client parrain dès la validation —
  // même transaction que la création du compte cabine, contrairement au
  // parrainage client->client (creditReferralRewardIfFirstOrder(),
  // api/orders_common.php) qui attend la 1re commande terminée. Le statut
  // 'en_attente' verrouillé par SELECT ... FOR UPDATE plus haut garantit
  // qu'une même candidature ne peut être validée — donc ce versement
  // déclenché — qu'une seule fois.
  $parrainReward = null;
  // Auto-parrainage impossible (même règle que create_account.php) : un
  // candidat ne peut pas toucher la récompense en indiquant son propre
  // numéro de candidature comme code de parrainage.
  if (!empty($app['parrain_telephone']) && $app['parrain_telephone'] !== $app['telephone']) {
    $parrainStmt = $pdo->prepare("SELECT id FROM profiles WHERE role = 'client' AND telephone = ?");
    $parrainStmt->execute([$app['parrain_telephone']]);
    $parrain = $parrainStmt->fetch();
    if ($parrain) {
      $pdo->prepare('UPDATE profiles SET solde = solde + 1000 WHERE id = ?')->execute([$parrain['id']]);
      $parrainReward = $parrain['id'];
    }
  }

  $pdo->commit();

  if ($parrainReward !== null) {
    createNotification($parrainReward,
      'La candidature partenaire que vous avez parrainée a été validée — 1 000 F ont été crédités sur votre solde. Merci d\'avoir parrainé KBINE PLUS !',
      'success');
  }
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

// Si le candidat a aussi un compte client (même numéro) — cas fréquent, la
// candidature se soumet depuis l'espace client — le prévient dans son fil
// de notifications que sa demande est validée et qu'il peut se connecter
// à son nouvel espace cabine avec le même email et le même code PIN
// choisis à l'inscription. Rien à envoyer autrement (pas de SMS/email
// configuré sur ce projet) : un candidat sans compte client doit encore
// être averti par l'administration elle-même.
$clientStmt = $pdo->prepare("SELECT id FROM profiles WHERE telephone = ? AND role = 'client'");
$clientStmt->execute([$app['telephone']]);
$clientProfile = $clientStmt->fetch();
if ($clientProfile) {
  createNotification($clientProfile['id'],
    'Félicitations ! Votre demande de partenariat a été validée. Connectez-vous à votre nouvel espace cabine avec l\'email et le code PIN choisis lors de votre inscription.',
    'success');
}

echo json_encode(['ok' => true, 'cabineId' => $cabineId]);
