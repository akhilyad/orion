/**
 * Orion — deployment configuration.
 * Edit this file before launch. No build step required.
 */
window.ORION_CONFIG = {
  productName: 'OrionPDF',
  version: '1.0.0',

  pricing: {
    // Bucketized pricing model. Premium is €1 — that is the whole pitch.
    free: { label: 'Stargazer', price: '€0', period: '1 free try' },
    premium: { label: 'Premium', price: '€1', period: '/month' },
    enterprise: { label: 'Enterprise', price: '€79', period: '/year · 10 seats' },
  },

  /**
   * Payment link for Premium (€1). Create a Stripe Payment Link
   * (or Paddle / Lemon Squeezy checkout URL) and paste it here.
   * While empty, checkout buttons show a toast with instructions
   * instead — nothing breaks.
   */
  premiumPaymentLink: 'https://buy.stripe.com/bJefZh5wP8CZaGhfzOgEg00',

  /** Where Enterprise leads go. */
  salesEmail: 'sales@orion-pdf.example',
  supportEmail: 'support@orion-pdf.example',

  /**
   * Firebase Auth config for the accounts page (account.html).
   * Paste the `firebaseConfig` object from the Firebase console here
   * (Project settings → Your apps → Web app). It contains only public
   * client identifiers — safe to commit. While null, the login page
   * runs in placeholder mode and offers key activation instead.
   */
  firebase: {
    apiKey: 'AIzaSyCK6YKfMPX5XCIgMOOudhRJjyauQGHb1pg',
    authDomain: 'orionpdf-e74a9.firebaseapp.com',
    projectId: 'orionpdf-e74a9',
    storageBucket: 'orionpdf-e74a9.firebasestorage.app',
    messagingSenderId: '420218743001',
    appId: '1:420218743001:web:8fd56ec838eb18c77836c8',
  },

  /**
   * Entitlement API — the free (Cloudflare Worker) alternative to the
   * Firebase Cloud Function. Deploy worker/ with wrangler and paste the
   * worker URL here, e.g. 'https://orion-entitlements.<you>.workers.dev'.
   * While empty, auth.js falls back to reading Firestore directly
   * (which requires the Blaze-plan Cloud Function to have written it).
   */
  entitlementApi: 'https://orion-entitlements.orionpdf.workers.dev',

  /** Free-trial limits (enforced client-side). */
  limits: {
    freeTries: 1, // documents a visitor can open (core tools only) before the €1 ask
  },
};
