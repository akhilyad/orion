/**
 * Orion — deployment configuration.
 * Edit this file before launch. No build step required.
 */
window.ORION_CONFIG = {
  productName: 'Orion',
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

  /** Free-trial limits (enforced client-side). */
  limits: {
    freeTries: 1, // documents a visitor can open (core tools only) before the €1 ask
  },
};
