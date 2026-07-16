/**
 * Orion — deployment configuration.
 * Edit this file before launch. No build step required.
 */
window.ORION_CONFIG = {
  productName: 'Orion',
  version: '1.0.0',

  pricing: {
    // Bucketized pricing model. Premium is €1 — that is the whole pitch.
    free: { label: 'Stargazer', price: '€0', period: 'forever' },
    premium: { label: 'Premium', price: '€1', period: '/month' },
    enterprise: { label: 'Enterprise', price: '€79', period: '/year · 10 seats' },
  },

  /**
   * Payment link for Premium (€1). Create a Stripe Payment Link
   * (or Paddle / Lemon Squeezy checkout URL) and paste it here.
   * While empty, the Buy button opens the activation modal instead,
   * with instructions — nothing breaks.
   */
  premiumPaymentLink: 'https://buy.stripe.com/test_14AcN69DS1zR9uxbXu9ws00',

  /** Where Enterprise leads go. */
  salesEmail: 'sales@orion-pdf.example',
  supportEmail: 'support@orion-pdf.example',

  /** Free-tier limits (enforced client-side). */
  limits: {
    freeMergeFiles: 1, // extra files merged per document on Free
  },
};
