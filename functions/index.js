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
const {defineSecret} = require('firebase-functions/params');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');

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

      res.status(200).json({success: true, subscriptionId: result.id});
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
    const driverSnap = await db.collection('drivers').doc(uid).get();
    if (!driverSnap.exists) {
      res.status(404).json({error: 'Motorista não encontrado.'});
      return;
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
          unit_amount: 2990,
        }],
        qr_codes: [{
          amount: {value: 2990},
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
