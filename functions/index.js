/**
 * LinkingGo — Cloud Functions: Pagamentos PagBank
 *
 * Funções:
 *   createSubscription  — cartão recorrente (POST /v1/subscriptions PagBank)
 *   createPixCharge     — cobrança PIX única (POST /charges PagBank)
 *   pagbankWebhook      — recebe notificações PagBank e atualiza Firestore
 *
 * Variáveis de ambiente (firebase functions:secrets:set):
 *   PAGBANK_TOKEN    — Bearer token da conta PagBank sandbox/produção
 *   PAGBANK_PLAN_ID  — ID do plano recorrente criado no PagBank dashboard
 *
 * Deploy:
 *   firebase deploy --only functions --project linkinggo
 */

const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// ── Secrets ────────────────────────────────────────────────────────────────
const PAGBANK_TOKEN   = defineSecret('PAGBANK_TOKEN');
const PAGBANK_PLAN_ID = defineSecret('PAGBANK_PLAN_ID');
const ADMIN_SECRET    = defineSecret('ADMIN_SECRET');
const ANTHROPIC_KEY   = defineSecret('ANTHROPIC_KEY');

// ── Ambiente PagBank ───────────────────────────────────────────────────────
// Para ir para produção: altere PAGBANK_ENV=production em functions/.env e faça redeploy
const PAGBANK_BASE = process.env.PAGBANK_ENV === 'production'
  ? 'https://api.pagseguro.com'
  : 'https://sandbox.api.pagseguro.com';

// ── Helper: requisição autenticada para o PagBank ─────────────────────────
async function pagbankRequest(token, method, path, body) {
  const {default: fetch} = await import('node-fetch');
  const res = await fetch(`${PAGBANK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error_messages?.[0]?.description
      || json?.message
      || JSON.stringify(json);
    throw new Error(`PagBank ${res.status}: ${msg}`);
  }
  return json;
}

// ── Helper: CORS simples para chamadas do navegador ───────────────────────
function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-secret');
}

// ─────────────────────────────────────────────────────────────────────────────
// createPagbankPlan — TEMPORÁRIA: cria o plano recorrente no PagBank produção
// Chamar UMA VEZ via GET, anotar o plan_id retornado, depois remover esta função
// ─────────────────────────────────────────────────────────────────────────────
exports.createPagbankPlan = onRequest(
  {secrets: [PAGBANK_TOKEN]},
  async (req, res) => {
    const {default: fetch} = await import('node-fetch');
    const token = PAGBANK_TOKEN.value();
    const results = {};

    // Teste 1: listar planos (GET recurring-billing)
    const r1 = await fetch(`${PAGBANK_BASE}/recurring-billing/v1/plans`, {
      headers: {Authorization: `Bearer ${token.trim()}`, Accept: 'application/json'},
    });
    results.listPlans = {status: r1.status, isCloudflare: (await r1.text()).includes('Cloudflare')};

    // Teste 2: endpoint /orders (usado pelo PIX)
    const r2 = await fetch(`${PAGBANK_BASE}/orders`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({reference_id: 'test-probe'}),
    });
    const body2 = await r2.text();
    results.ordersEndpoint = {status: r2.status, isCloudflare: body2.includes('Cloudflare'), preview: body2.slice(0, 200)};

    // Teste 3: endpoint de assinaturas recorrentes
    const r3 = await fetch(`${PAGBANK_BASE}/recurring-billing/v1/subscriptions`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({reference_id: 'test-probe'}),
    });
    const body3 = await r3.text();
    results.subscriptionsEndpoint = {status: r3.status, isCloudflare: body3.includes('Cloudflare'), preview: body3.slice(0, 200)};

    // Teste 4: cobrança PIX real de R$1,00 — só se ?pix=1
    if (req.query.pix === '1' && req.method === 'POST') {
      const {cpf, email, name} = req.body || {};
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const pixPayload = {
        reference_id: 'producao-teste-linkinggo',
        customer: {
          name: name || 'Teste Producao',
          email,
          tax_id: (cpf || '').replace(/\D/g, ''),
        },
        items: [{
          name:        'LinkingGo Premium — teste producao',
          quantity:    1,
          unit_amount: 100,
        }],
        qr_codes: [{
          amount:          {value: 100},
          expiration_date: expiresAt,
        }],
        notification_urls: ['https://pagbankwebhook-bqwrf4cd6q-uc.a.run.app'],
      };

      const r4 = await fetch(`${PAGBANK_BASE}/orders`, {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${token.trim()}`,
          'Content-Type': 'application/json',
          Accept:         'application/json',
        },
        body: JSON.stringify(pixPayload),
      });
      const pixBody = await r4.json().catch(() => ({}));
      results.pixTest = {
        requestUrl:     `${PAGBANK_BASE}/orders`,
        requestPayload: pixPayload,
        responseStatus: r4.status,
        responseBody:   pixBody,
      };
    }

    res.status(200).json(results);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// createSubscription — cartão de crédito recorrente
// Body: { uid, cardEncrypted, holderName, holderDocument (CPF), email }
// ─────────────────────────────────────────────────────────────────────────────
exports.createSubscription = onRequest(
  {secrets: [PAGBANK_TOKEN, PAGBANK_PLAN_ID]},
  async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST')    { res.status(405).send('Method Not Allowed'); return; }

    const {uid, cardEncrypted, holderName, holderDocument, email} = req.body || {};

    if (!uid || !cardEncrypted || !holderName || !holderDocument || !email) {
      res.status(400).json({error: 'Campos obrigatórios ausentes.'});
      return;
    }

    // Verifica se o driver existe no Firestore
    const driverRef = db.collection('drivers').doc(uid);
    const driverSnap = await driverRef.get();
    if (!driverSnap.exists) {
      res.status(404).json({error: 'Motorista não encontrado.'});
      return;
    }

    // Verifica desconto 10% para driver vinculado a empresa ativa
    let discountApplied = false;
    const driverData = driverSnap.data() || {};
    if (driverData.activeCompany) {
      const compSnap = await db.collection('companies').doc(driverData.activeCompany).get();
      if (compSnap.exists && compSnap.data().paymentStatus !== 'BLOCKED') {
        discountApplied = true;
      }
    }

    try {
      const token  = PAGBANK_TOKEN.value();
      const planId = PAGBANK_PLAN_ID.value();

      const payload = {
        reference_id: uid,
        plan: {id: planId},
        customer: {
          name: holderName,
          email,
          tax_id: holderDocument.replace(/\D/g, ''),
        },
        payment_method: {
          type: 'CREDIT_CARD',
          card: {encrypted: cardEncrypted},
        },
      };

      const result = await pagbankRequest(token, 'POST', '/recurring-billing/v1/subscriptions', payload);

      // Guarda dados básicos; o webhook confirma o status final
      const nextBillingMs = result.next_invoice_at
        ? new Date(result.next_invoice_at).getTime()
        : Date.now() + 31 * 24 * 60 * 60 * 1000;

      await driverRef.set({
        isPremium:          true,
        subscriptionId:     result.id,
        subscriptionStatus: 'active',
        premiumSince:       Date.now(),
        premiumExpiresAt:   nextBillingMs,
      }, {merge: true});

      res.status(200).json({success: true, subscriptionId: result.id, discountApplied});
    } catch (err) {
      console.error('[createSubscription]', err.message);
      res.status(500).json({error: err.message});
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// createPixCharge — gera cobrança PIX única de 30 dias
// Body: { uid, email, name, taxId (CPF) }
// ─────────────────────────────────────────────────────────────────────────────
exports.createPixCharge = onRequest(
  {secrets: [PAGBANK_TOKEN]},
  async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST')    { res.status(405).send('Method Not Allowed'); return; }

    const {uid, email, name, taxId} = req.body || {};

    if (!uid || !name) {
      res.status(400).json({error: 'Campos obrigatórios ausentes.'});
      return;
    }

    // Verifica se o driver existe
    const pixDriverSnap = await db.collection('drivers').doc(uid).get();
    if (!pixDriverSnap.exists) {
      res.status(404).json({error: 'Motorista não encontrado.'});
      return;
    }

    // Verifica desconto 10% para driver vinculado a empresa ativa
    let pixAmount = 2990; // R$29,90
    const pixDriverData = pixDriverSnap.data() || {};
    if (pixDriverData.activeCompany) {
      const compSnap = await db.collection('companies').doc(pixDriverData.activeCompany).get();
      if (compSnap.exists && compSnap.data().paymentStatus !== 'BLOCKED') {
        pixAmount = 100; // TODO: voltar para 2691 (R$26,91) após homologação
      }
    }

    try {
      const token = PAGBANK_TOKEN.value();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const customer = {name, email: `${uid}@linkinggo.app`};
      if (taxId) { customer.tax_id = taxId.replace(/\D/g, ''); }

      const payload = {
        reference_id: uid,
        customer,
        items: [{
          name:        'LinkingGo Premium — 30 dias',
          quantity:    1,
          unit_amount: pixAmount,
        }],
        qr_codes: [{
          amount: {value: pixAmount},
          expiration_date: expiresAt,
        }],
        notification_urls: ['https://pagbankwebhook-bqwrf4cd6q-uc.a.run.app'],
      };

      const result = await pagbankRequest(token, 'POST', '/orders', payload);

      // Extrai QR code PIX do response
      const qrCode = result.qr_codes?.[0];
      const qrImageLink = qrCode?.links?.find(l => l.rel === 'QRCODE.PNG')?.href || null;

      res.status(200).json({
        chargeId:    result.id,
        qrCodeText:  qrCode?.text || null,
        qrCodeImage: qrImageLink,
      });
    } catch (err) {
      console.error('[createPixCharge]', err.message);
      res.status(500).json({error: err.message});
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// linkDriverToCompany — vincula motorista a empresa via código de 6 dígitos
// Body: { uid, companyCode }
// ─────────────────────────────────────────────────────────────────────────────
exports.linkDriverToCompany = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST')    { res.status(405).send('Method Not Allowed'); return; }

  const {uid, companyCode} = req.body || {};
  if (!uid || !companyCode) {
    res.status(400).json({error: 'Campos obrigatórios ausentes.'});
    return;
  }

  const code = companyCode.toString().trim();
  if (code.length !== 6) {
    res.status(400).json({error: 'Código deve ter 6 dígitos.'});
    return;
  }

  try {
    // 1. Lookup companyId via short code
    const codeSnap = await db.collection('companyCodes').doc(code).get();
    if (!codeSnap.exists) {
      res.status(404).json({error: 'Código não encontrado. Verifique com o gestor.'});
      return;
    }
    const companyId = codeSnap.data().companyId;

    const companyRef = db.collection('companies').doc(companyId);
    const driverRef  = db.collection('drivers').doc(uid);

    // 2. Transação atômica: valida e executa vínculo
    const result = await db.runTransaction(async tx => {
      const [companySnap, driverSnap] = await Promise.all([
        tx.get(companyRef),
        tx.get(driverRef),
      ]);

      if (!companySnap.exists) throw new Error('Empresa não encontrada.');
      const company = companySnap.data();

      if (!company.active) throw new Error('Empresa inativa.');
      if (company.paymentStatus === 'BLOCKED') {
        throw new Error('Empresa com pagamento bloqueado. Contate o gestor.');
      }

      const linkedCount = company.driverLinkedCount || 0;
      const limit       = company.driverLimit || 0;
      if (linkedCount >= limit) throw new Error('Empresa sem vagas disponíveis.');

      const driver = driverSnap.data() || {};
      if (driver.activeCompany) throw new Error('Você já está vinculado a uma empresa.');

      const now = Date.now();
      tx.update(companyRef, {driverLinkedCount: FieldValue.increment(1)});
      tx.set(driverRef, {
        activeCompany:    companyId,
        companyLinkedAt:  now,
        companyRemovedAt: null,
      }, {merge: true});
      tx.set(db.collection('companyDriverLinks').doc(), {
        driverId:  uid,
        companyId: companyId,
        status:    'active',
        linkedAt:  now,
      });

      return {companyName: company.name, paymentStatus: company.paymentStatus};
    });

    res.status(200).json({
      success:       true,
      companyId,
      companyName:   result.companyName,
      paymentStatus: result.paymentStatus,
    });
  } catch (err) {
    console.error('[linkDriverToCompany]', err.message);
    const status = err.message.includes('não encontrad') ? 404 : 400;
    res.status(status).json({error: err.message});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// dailyCleanup — limpeza automática de histórico de entregas
//
// Regras:
//   1. Rotas com mais de 30 dias → deletar (todos os usuários)
//   2. Rotas de drivers cujo trial expirou no dia 22 sem assinar → deletar
//
// Roda diariamente às 03:00 (horário de Brasília)
// Requer Cloud Scheduler API ativada no projeto GCP (plano Blaze)
// ─────────────────────────────────────────────────────────────────────────────
exports.dailyCleanup = onSchedule(
  {schedule: 'every day 03:00', timeZone: 'America/Sao_Paulo'},
  async () => {
    const now          = Date.now();
    const THIRTY_DAYS  = 30 * 24 * 60 * 60 * 1000;
    const TWENTY_TWO_DAYS = 22 * 24 * 60 * 60 * 1000;
    let totalDeleted   = 0;

    // Helper: deleta um array de DocumentRefs em batches de 500
    async function batchDelete(refs) {
      if (refs.length === 0) return;
      for (let i = 0; i < refs.length; i += 500) {
        const batch = db.batch();
        refs.slice(i, i + 500).forEach(ref => batch.delete(ref));
        await batch.commit();
      }
    }

    // ── Regra 1: rotas com mais de 30 dias (todos os usuários) ──────────────
    const oldSnap = await db.collection('routes')
      .where('createdAt', '<', now - THIRTY_DAYS)
      .get();

    await batchDelete(oldSnap.docs.map(d => d.ref));
    totalDeleted += oldSnap.size;
    console.log(`[dailyCleanup] Regra 30d: ${oldSnap.size} rotas deletadas`);

    // ── Regra 2: trial expirado no dia 12 sem Premium nem empresa ───────────
    const trialExpiredSnap = await db.collection('drivers')
      .where('createdAt', '<', now - TWENTY_TWO_DAYS)
      .get();

    // Filtra em código: sem Premium e sem empresa vinculada
    const expiredUids = trialExpiredSnap.docs
      .filter(doc => {
        const d = doc.data();
        return !d.isPremium && !d.activeCompany;
      })
      .map(doc => doc.id);

    if (expiredUids.length > 0) {
      // Busca as rotas de cada driver em paralelo (chunks de 10)
      const routeRefs = [];
      for (let i = 0; i < expiredUids.length; i += 10) {
        const chunk = expiredUids.slice(i, i + 10);
        const snaps = await Promise.all(
          chunk.map(uid =>
            db.collection('routes').where('driverId', '==', uid).get()
          )
        );
        snaps.forEach(snap => snap.docs.forEach(doc => routeRefs.push(doc.ref)));
      }

      await batchDelete(routeRefs);
      totalDeleted += routeRefs.length;
      console.log(
        `[dailyCleanup] Regra 12d: ${routeRefs.length} rotas de` +
        ` ${expiredUids.length} drivers sem Premium deletadas`
      );
    }

    console.log(`[dailyCleanup] Total deletado: ${totalDeleted} rotas`);

    // ── Regra 3: Empresas em TRIAL com trialEndsAt expirado → OVERDUE ────────
    const trialCompaniesSnap = await db.collection('companies')
      .where('paymentStatus', '==', 'TRIAL')
      .where('trialEndsAt', '<', now)
      .get();

    if (!trialCompaniesSnap.empty) {
      const batch = db.batch();
      trialCompaniesSnap.docs.forEach(d => batch.update(d.ref, {paymentStatus: 'OVERDUE'}));
      await batch.commit();
      console.log(`[dailyCleanup] ${trialCompaniesSnap.size} empresa(s) TRIAL → OVERDUE`);
    }

    // ── Regra 4: Empresas ACTIVE com subscriptionExpiresAt expirado → OVERDUE
    const activeCompaniesSnap = await db.collection('companies')
      .where('paymentStatus', '==', 'ACTIVE')
      .where('subscriptionExpiresAt', '<', now)
      .get();

    if (!activeCompaniesSnap.empty) {
      const batch = db.batch();
      activeCompaniesSnap.docs.forEach(d => batch.update(d.ref, {paymentStatus: 'OVERDUE'}));
      await batch.commit();
      console.log(`[dailyCleanup] ${activeCompaniesSnap.size} empresa(s) ACTIVE → OVERDUE`);
    }

    // ── Regra 5: Drivers autônomos com premiumExpiresAt vencido → OVERDUE ────
    const overdueDriversSnap = await db.collection('drivers')
      .where('isPremium', '==', true)
      .where('premiumExpiresAt', '<', now)
      .get();

    if (!overdueDriversSnap.empty) {
      const batch = db.batch();
      overdueDriversSnap.docs.forEach(d =>
        batch.update(d.ref, {isPremium: false, subscriptionStatus: 'overdue'})
      );
      await batch.commit();
      console.log(`[dailyCleanup] ${overdueDriversSnap.size} driver(s) premium vencido → overdue`);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// registerDevice — registra ou valida o dispositivo do driver (1 device por conta)
// Header: Authorization: Bearer <Firebase ID Token>
// Body: { deviceId, deviceModel }
// ─────────────────────────────────────────────────────────────────────────────
const {getAuth} = require('firebase-admin/auth');

exports.registerDevice = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST')    { res.status(405).send('Method Not Allowed'); return; }

  try {
    // Verifica o Firebase ID token
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({error: 'Token de autenticação ausente.'});
      return;
    }
    const decoded = await getAuth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const {deviceId, deviceModel} = req.body || {};
    if (!deviceId) {
      res.status(400).json({error: 'deviceId obrigatório.'});
      return;
    }

    const driverRef = db.collection('drivers').doc(uid);

    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(driverRef);
      const stored = snap.exists ? (snap.data().deviceId || null) : null;

      if (!stored || stored === deviceId) {
        // Primeiro registro ou mesmo dispositivo — atualiza lastSeen
        tx.set(driverRef, {
          deviceId,
          deviceModel: deviceModel || null,
          deviceLastSeen: Date.now(),
        }, {merge: true});
        return {success: true};
      }

      // Dispositivo diferente do registrado
      return {error: 'device_conflict'};
    });

    if (result.error) {
      res.status(403).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    console.error('[registerDevice]', err.message);
    res.status(500).json({error: err.message});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// resetDriverDevice — admin reseta o dispositivo vinculado de um driver
// Header: x-admin-secret: <ADMIN_SECRET>
// Body: { targetUid }
// ─────────────────────────────────────────────────────────────────────────────
exports.resetDriverDevice = onRequest(
  {secrets: [ADMIN_SECRET]},
  async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST')    { res.status(405).send('Method Not Allowed'); return; }

    const secret = req.headers['x-admin-secret'];
    if (!secret || secret !== ADMIN_SECRET.value()) {
      res.status(403).json({error: 'Acesso negado.'});
      return;
    }

    const {targetUid} = req.body || {};
    if (!targetUid) {
      res.status(400).json({error: 'targetUid obrigatório.'});
      return;
    }

    try {
      await db.collection('drivers').doc(targetUid).set({
        deviceId:       null,
        deviceModel:    null,
        deviceLastSeen: null,
      }, {merge: true});

      console.log(`[resetDriverDevice] dispositivo resetado para uid=${targetUid}`);
      res.status(200).json({success: true, uid: targetUid});
    } catch (err) {
      console.error('[resetDriverDevice]', err.message);
      res.status(500).json({error: err.message});
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// checkPixStatus — premium.html polling: verifica se driver virou premium
// Body: { uid }
// ─────────────────────────────────────────────────────────────────────────────
exports.checkPixStatus = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST')    { res.status(405).send('Method Not Allowed'); return; }

  const {uid} = req.body || {};
  if (!uid) { res.status(400).json({error: 'uid obrigatório'}); return; }

  const snap = await db.collection('drivers').doc(uid).get();
  if (!snap.exists) { res.status(404).json({paid: false}); return; }

  const data = snap.data() || {};
  res.status(200).json({paid: data.isPremium === true});
});

// ─────────────────────────────────────────────────────────────────────────────
// pagbankWebhook — recebe notificações de cobrança/assinatura do PagBank
// URL pública; configurar no painel PagBank → Webhooks
// ─────────────────────────────────────────────────────────────────────────────
exports.pagbankWebhook = onRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  const event = req.body || {};

  // Log completo temporário para diagnóstico de estrutura do payload PagBank
  console.log('[pagbankWebhook] payload completo:', JSON.stringify(event));

  // PagBank pode enviar o tipo em campos diferentes conforme a versão da API
  // Para pedidos PIX, o payload é o objeto do pedido diretamente (sem campo type)
  let eventType = event.type || event.event_type || event.data?.type || '';

  if (!eventType && Array.isArray(event.charges)) {
    const allPaid = event.charges.every(c => c.status === 'PAID');
    if (allPaid && event.charges.length > 0) eventType = 'ORDER_PAID';
  }

  // reference_id é o uid do motorista — PagBank aninha em diferentes locais
  const uid = event.reference_id
    || event.data?.reference_id
    || event.subscription?.reference_id
    || event.charge?.reference_id
    || event.order?.reference_id
    || event.data?.order?.reference_id
    || event.data?.charge?.reference_id;

  if (!uid) {
    console.warn('[pagbankWebhook] sem reference_id no evento:', eventType, '| keys:', Object.keys(event).join(','));
    res.status(200).send('OK');
    return;
  }

  const driverRef = db.collection('drivers').doc(uid);

  try {
    switch (eventType) {

      // Assinatura criada e ativada
      case 'SUBSCRIPTION_ACTIVATED':
        await driverRef.set({
          isPremium:          true,
          subscriptionStatus: 'active',
          premiumSince:       Date.now(),
        }, {merge: true});
        break;

      // Cobrança bem-sucedida (cartão recorrente ou PIX)
      case 'CHARGE_PAID':
      case 'ORDER_PAID': {
        const now = Date.now();
        const isRecurring = !!event.subscription;

        // Extrai dados do pagamento do payload do PagBank
        const charge      = (event.charges || [])[0] || {};
        const paidAt      = charge.paid_at ? new Date(charge.paid_at).getTime() : now;
        const paidAmount  = charge.amount?.value ?? 0;
        const orderId     = event.id || charge.metadata?.ps_order_id || '';
        const payMethod   = isRecurring ? 'CREDIT_CARD' : 'PIX';

        if (isRecurring) {
          const nextMs = event.subscription?.next_invoice_at
            ? new Date(event.subscription.next_invoice_at).getTime()
            : now + 32 * 24 * 60 * 60 * 1000;

          await driverRef.set({
            isPremium:          true,
            subscriptionStatus: 'active',
            premiumExpiresAt:   nextMs,
            lastPaymentAt:      paidAt,
            lastPaymentAmount:  paidAmount,
            lastPaymentOrderId: orderId,
            paymentMethod:      payMethod,
          }, {merge: true});
        } else {
          // PIX / cobrança avulsa: 30 dias a partir da data do pagamento
          await driverRef.set({
            isPremium:          true,
            subscriptionStatus: 'active',
            premiumSince:       paidAt,
            premiumExpiresAt:   paidAt + 30 * 24 * 60 * 60 * 1000,
            lastPaymentAt:      paidAt,
            lastPaymentAmount:  paidAmount,
            lastPaymentOrderId: orderId,
            paymentMethod:      payMethod,
          }, {merge: true});
        }
        break;
      }

      // Cobrança falhou — grace period de 3 dias
      case 'CHARGE_FAILED':
        await driverRef.set({
          premiumExpiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
        }, {merge: true});
        break;

      // Assinatura cancelada
      case 'SUBSCRIPTION_CANCELLED':
      case 'SUBSCRIPTION_INACTIVE':
        await driverRef.set({
          isPremium:          false,
          subscriptionStatus: 'cancelled',
        }, {merge: true});
        break;

      default:
        console.log('[pagbankWebhook] evento não tratado:', eventType);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('[pagbankWebhook] erro ao atualizar Firestore:', err.message);
    res.status(500).send('Error');
  }
});

// ── chatSupport — IA de atendimento via Claude Haiku ──────────────────────────
const CHAT_SYSTEM_PROMPT = `Você é o assistente de suporte do LinkingGo, um app Android para motoristas de entrega no Brasil.
Responda sempre em português brasileiro, de forma clara, objetiva e amigável.
Nunca invente funcionalidades que não existam. Se não souber, oriente o usuário a contatar o suporte pelo e-mail suporte@linkinggo.com.br.

CONHECIMENTO DO APP:

CONTA E ACESSO:
- Cadastro: nome completo (nome + sobrenome), e-mail real, telefone no formato (11) 99999-9999, senha mínima de 8 caracteres.
- Após cadastro, é enviado um e-mail de verificação. O usuário deve clicar no link antes de fazer login.
- Login disponível por e-mail/senha ou conta Google.
- "Manter logado": quando ativado, o app mantém a sessão ao fechar. Quando desativado, exige login a cada abertura.
- Esqueceu a senha: na tela de login, clicar em "Esqueceu a senha?" e informar o e-mail.
- Reenviar verificação: na tela de login, tentar entrar com e-mail não verificado → aparece link "Reenviar e-mail de verificação".
- 1 dispositivo por conta: a conta fica vinculada ao primeiro celular utilizado.

ROTAS E ENTREGAS:
- A tela principal mostra as paradas da rota do dia.
- Adicionar parada: botão "+" → informar endereço, destinatário e observação.
- Importar paradas: botão CSV → colar o conteúdo do CSV no campo de texto. Formato: endereço,destinatário,observação (uma por linha).
- Cada parada tem status: Pendente, Entregue, Recusado, Cancelado.
- Alterar status: tocar na parada → selecionar novo status → confirmar com foto (obrigatório para Entregue e Recusado).
- Arrastar paradas para reordenar a rota.
- Limpar paradas: menu lateral → "Limpar Paradas" (remove todas as paradas do dia).
- Histórico: menu lateral → "Histórico" → lista de rotas anteriores com fotos.

MAPA:
- Menu lateral → ícone de mapa → abre mapa com marcadores de todas as paradas.
- Tocar em um marcador exibe o endereço e botão de navegação.
- Botão de navegação abre o Google Maps com rota até a parada.
- O mapa mostra a posição atual do motorista em tempo real.

PREMIUM:
- Plano Premium: R$29,90/mês, renovação automática a cada 30 dias.
- Pagamento via PIX (QR Code gerado na hora) ou cartão de crédito.
- Para assinar: menu lateral → "Assinar Premium" → tela de pagamento.
- Após pagamento confirmado, o app atualiza automaticamente (sem precisar fechar).
- Conta Premium: menu lateral mostra "⭐ Premium Ativo" com a data de validade.
- Cancelamento: entrar em contato com suporte@linkinggo.com.br.

EMPRESA:
- Motoristas podem ser vinculados a uma empresa gestora.
- Para vincular: menu lateral → "Vincular Empresa" → inserir o código de 6 dígitos fornecido pela empresa.
- Após vinculação, o acesso Premium é gerenciado pela empresa.
- Para desvincular: entrar em contato com suporte@linkinggo.com.br.

PROBLEMAS COMUNS:
- Tela vermelha ao abrir: o app perdeu conexão com o servidor de desenvolvimento. Reinstale o app.
- E-mail de verificação não chegou: verificar pasta de spam. Usar "Reenviar e-mail de verificação" na tela de login.
- "Este dispositivo já está vinculado": a conta está registrada em outro celular. Contatar suporte para liberar.
- App lento ou travando: fechar e reabrir o app. Se persistir, limpar o cache do app nas configurações do Android.
- Foto não enviou: verificar conexão com a internet e tentar novamente.`;

const CHAT_RATE_LIMIT = new Map(); // sessionId → {count, ts}

exports.chatSupport = onRequest(
  {secrets: [ANTHROPIC_KEY], cors: true, timeoutSeconds: 30},
  async (req, res) => {
    if (req.method !== 'POST') { return res.status(405).send('Method Not Allowed'); }

    try {
      const {messages, sessionId} = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({error: 'messages obrigatório.'});
      }

      // Rate limit: máx 20 mensagens por sessão por hora
      if (sessionId) {
        const now = Date.now();
        const entry = CHAT_RATE_LIMIT.get(sessionId) || {count: 0, ts: now};
        if (now - entry.ts > 3600000) { entry.count = 0; entry.ts = now; }
        entry.count++;
        CHAT_RATE_LIMIT.set(sessionId, entry);
        if (entry.count > 20) {
          return res.status(429).json({error: 'Limite de mensagens atingido. Tente novamente em 1 hora.'});
        }
      }

      // Manter apenas as últimas 10 mensagens para economizar tokens
      const history = messages.slice(-10).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content).slice(0, 1000),
      }));

      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic.default({apiKey: ANTHROPIC_KEY.value()});

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: CHAT_SYSTEM_PROMPT,
        messages: history,
      });

      const reply = response.content[0]?.text || 'Não consegui processar sua mensagem. Tente novamente.';
      res.json({reply});
    } catch (err) {
      console.error('[chatSupport]', err.message);
      res.status(500).json({error: 'Erro interno. Tente novamente.'});
    }
  }
);
