// Minimal Express server to integrate Stripe checkout, portal, and webhook handling
// This example illustrates how to wire up your WotanEye Dynamics front‑end with
// Stripe. You must set the corresponding environment variables in your
// deployment environment (see README comments below).

const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');

// Read configuration from environment variables. Do NOT hardcode secrets.
const {
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_PRO_MONTHLY,
  STRIPE_PRICE_BUSINESS_MONTHLY,
  STRIPE_WEBHOOK_SECRET,
  APP_URL,
} = process.env;

// Instantiate Stripe client with your secret key.
const stripe = Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15',
});

const app = express();

// Use JSON parser for non‑webhook routes
app.use('/api/billing/webhooks', bodyParser.raw({ type: '*/*' }));
app.use(bodyParser.json());

/*
 * Helper to retrieve or create a Stripe customer. In your actual
 * implementation, you should look up the customer by your own
 * organisation ID in your database. For example, you might store
 * stripeCustomerId on an Organisation record. Here we simply
 * create a new customer every time for demonstration purposes.
 */
async function getOrCreateCustomer(orgId) {
  // TODO: Replace with your own customer lookup based on orgId
  const customer = await stripe.customers.create({
    description: `Customer for org ${orgId}`,
    metadata: { orgId },
  });
  return customer.id;
}

/*
 * Endpoint: POST /api/billing/checkout
 * Creates a new Stripe Checkout session for a subscription. The client
 * should send { plan: 'pro' | 'business', orgId: '...' } in the request body.
 * It returns the session URL for the front‑end to redirect the user.
 */
app.post('/api/billing/checkout', async (req, res) => {
  const { plan, orgId } = req.body;
  if (!plan || !orgId) {
    return res.status(400).json({ error: 'Missing plan or orgId' });
  }
  // Determine the price ID from the plan
  const priceId = plan === 'business'
    ? STRIPE_PRICE_BUSINESS_MONTHLY
    : STRIPE_PRICE_PRO_MONTHLY;
  try {
    // Get existing or create new customer
    const customerId = await getOrCreateCustomer(orgId);
    // Create the checkout session. Payment method collection is set
    // to always collect a card up front, even for trials.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      payment_method_collection: 'always',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { orgId, plan },
      },
      success_url: `${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/pricing?canceled=1`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('Error creating checkout session:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/*
 * Endpoint: GET /api/billing/portal
 * Creates a customer portal session so that users can manage their
 * subscriptions and payment methods. The client should pass
 * orgId in the query string (?orgId=...).
 */
app.get('/api/billing/portal', async (req, res) => {
  const { orgId } = req.query;
  if (!orgId) {
    return res.status(400).send('orgId is required');
  }
  try {
    // Look up the Stripe customer for the organisation
    const customerId = await getOrCreateCustomer(orgId);
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_URL}/settings/billing`,
    });
    return res.redirect(portalSession.url);
  } catch (err) {
    console.error('Error creating billing portal session:', err);
    return res.status(500).send('Internal server error');
  }
});

/*
 * Endpoint: POST /api/billing/webhooks
 * Handles Stripe webhook events. Configure your Stripe dashboard to
 * send events to this endpoint and set STRIPE_WEBHOOK_SECRET. You
 * should verify the signature and then handle the event types your
 * application cares about. In this example we update an in‑memory
 * map of organisations to subscription plans. Replace this with
 * database logic to persist subscription state.
 */
const subscriptions = {};
app.post('/api/billing/webhooks', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  const { type, data } = event;
  // Handle the relevant events
  switch (type) {
    case 'checkout.session.completed': {
      const session = data.object;
      const { orgId, plan } = session.subscription ? session.metadata : session;
      // Mark the organisation as trialing
      subscriptions[orgId] = { plan, status: 'trialing' };
      console.log(`Checkout completed for org ${orgId}: trialing ${plan}`);
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = data.object;
      const orgId = subscription.metadata.orgId;
      const plan = subscription.metadata.plan;
      subscriptions[orgId] = { plan, status: subscription.status };
      console.log(`Subscription updated for org ${orgId}: ${subscription.status}`);
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = data.object;
      const orgId = subscription.metadata.orgId;
      subscriptions[orgId] = { plan: 'free', status: 'canceled' };
      console.log(`Subscription canceled for org ${orgId}`);
      break;
    }
    // Add more event types as required
    default:
      console.log(`Unhandled event type ${type}`);
  }
  // Return a response to acknowledge receipt of the event
  res.json({ received: true });
});

// Start the server if this file is executed directly
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Stripe server listening on port ${port}`);
  });
}

/*
 * README
 * ======
 *
 * 1. Install dependencies:
 *    npm install express body-parser stripe
 *
 * 2. Set the following environment variables in your deployment:
 *    STRIPE_SECRET_KEY         – Your secret key from the Stripe dashboard
 *    STRIPE_PRICE_PRO_MONTHLY   – The price ID for the Pro plan ($49/mo)
 *    STRIPE_PRICE_BUSINESS_MONTHLY – The price ID for the Business plan ($199/mo)
 *    STRIPE_WEBHOOK_SECRET     – The signing secret for your webhook endpoint
 *    APP_URL                   – Your deployed front‑end base URL (e.g. https://wotan-eye-dynamics.com)
 *
 * 3. Expose /api/billing/checkout and /api/billing/portal to your front‑end.
 *    In your Next.js/React code, call POST /api/billing/checkout with
 *    { plan: 'pro' | 'business', orgId } to initiate checkout. Then
 *    redirect the user to the returned URL. For the billing portal,
 *    link to /api/billing/portal?orgId=....
 *
 * 4. Configure your Stripe account to send webhook events to
 *    /api/billing/webhooks and set the STRIPE_WEBHOOK_SECRET to the
 *    signing secret provided by Stripe. Update the event handlers as
 *    needed to persist subscription state in your database.
 */
