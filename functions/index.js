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

// ── Ambiente PagBank (troque para produção quando sair do sandbox) ─────────
const PAGBANK_BASE = 'https://sandbox.api.pagseguro.com';

// ── Helper: requisição autenticada para o PagBank ─────────────────────────
async function pagbankRequest(token, method, path, body) {
  const {default: fetch} = await import('node-fetch');
  const res = await fetch(`${PAGBANK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

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

    if (!uid || !email || !name) {
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
    let pixAmount = 2990;
    const pixDriverData = pixDriverSnap.data() || {};
    if (pixDriverData.activeCompany) {
      const compSnap = await db.collection('companies').doc(pixDriverData.activeCompany).get();
      if (compSnap.exists && compSnap.data().paymentStatus !== 'BLOCKED') {
        pixAmount = 2691; // R$26,91 (10% off)
      }
    }

    try {
      const token = PAGBANK_TOKEN.value();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const payload = {
        reference_id: uid,
        customer: {
          name,
          email,
          tax_id: (taxId || '00000000000').replace(/\D/g, ''),
        },
        items: [{
          name:        'LinkingGo Premium — 30 dias',
          quantity:    1,
          unit_amount: pixAmount,
        }],
        qr_codes: [{
          amount: {value: pixAmount},
          expiration_date: expiresAt,
        }],
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
//   2. Rotas de drivers cujo trial expirou no dia 12 sem assinar → deletar
//
// Roda diariamente às 03:00 (horário de Brasília)
// Requer Cloud Scheduler API ativada no projeto GCP (plano Blaze)
// ─────────────────────────────────────────────────────────────────────────────
exports.dailyCleanup = onSchedule(
  {schedule: 'every day 03:00', timeZone: 'America/Sao_Paulo'},
  async () => {
    const now          = Date.now();
    const THIRTY_DAYS  = 30 * 24 * 60 * 60 * 1000;
    const TWELVE_DAYS  = 12 * 24 * 60 * 60 * 1000;
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
      .where('createdAt', '<', now - TWELVE_DAYS)
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
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// pagbankWebhook — recebe notificações de cobrança/assinatura do PagBank
// URL pública; configurar no painel PagBank → Webhooks
// ─────────────────────────────────────────────────────────────────────────────
exports.pagbankWebhook = onRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  const event = req.body || {};

  // PagBank pode enviar o tipo em campos diferentes conforme a versão da API
  const eventType = event.type || event.event_type || '';

  // reference_id é o uid do motorista que passamos ao criar o recurso
  const uid = event.reference_id
    || event.subscription?.reference_id
    || event.charge?.reference_id
    || event.order?.reference_id;

  if (!uid) {
    console.warn('[pagbankWebhook] sem reference_id no evento:', eventType);
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

        if (isRecurring) {
          // Recorrente: usa a data da próxima fatura do PagBank
          const nextMs = event.subscription?.next_invoice_at
            ? new Date(event.subscription.next_invoice_at).getTime()
            : now + 32 * 24 * 60 * 60 * 1000;

          await driverRef.set({
            isPremium:          true,
            subscriptionStatus: 'active',
            premiumExpiresAt:   nextMs,
          }, {merge: true});
        } else {
          // PIX / cobrança avulsa: 30 dias a partir de agora
          await driverRef.set({
            isPremium:          true,
            subscriptionStatus: 'active',
            premiumSince:       now,
            premiumExpiresAt:   now + 30 * 24 * 60 * 60 * 1000,
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
