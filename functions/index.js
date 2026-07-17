/**
 * Orion — Stripe → Firebase premium activation.
 *
 * One HTTPS function, `stripeWebhook`, receives Stripe webhook events:
 *
 *   checkout.session.completed   → grant premium to the buyer's email
 *   customer.subscription.deleted → revoke premium (subscription cancelled)
 *
 * Entitlements live in Firestore at entitlements/{email-lowercased}:
 *   { premium: boolean, since: timestamp, sessionId?: string }
 *
 * The website (public/js/auth.js) reads that document over the Firestore
 * REST API after the user signs in; if premium is true the browser is
 * unlocked. The buyer must sign in with the same email they paid with.
 *
 * Secrets (set once, see README):
 *   firebase functions:secrets:set STRIPE_SECRET_KEY
 *   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
 */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

function entitlementRef(email) {
  return admin.firestore().collection('entitlements').doc(email.toLowerCase());
}

exports.stripeWebhook = onRequest(
  { region: 'europe-west1', secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY.value());

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      res.status(400).send('Invalid signature');
      return;
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const email =
            (session.customer_details && session.customer_details.email) ||
            session.customer_email;
          if (!email) {
            console.warn('checkout.session.completed without an email', session.id);
            break;
          }
          await entitlementRef(email).set(
            {
              premium: true,
              since: admin.firestore.FieldValue.serverTimestamp(),
              sessionId: session.id,
            },
            { merge: true }
          );
          console.log('Premium granted:', email.toLowerCase());
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          // The subscription object carries only the customer id — look up
          // the email so we know which entitlement to revoke.
          const customer = await stripe.customers.retrieve(sub.customer);
          const email = customer && customer.email;
          if (!email) {
            console.warn('subscription.deleted with no customer email', sub.id);
            break;
          }
          await entitlementRef(email).set(
            { premium: false, revokedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
          console.log('Premium revoked:', email.toLowerCase());
          break;
        }

        default:
          // Acknowledge everything else so Stripe stops retrying.
          break;
      }
      res.status(200).send('ok');
    } catch (err) {
      console.error('Webhook handling failed:', err);
      res.status(500).send('Internal error');
    }
  }
);
