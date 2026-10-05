// Public, non-secret settings. Fill in from your Auth0 application (Single Page Application).
// mode "dev" works only under `netlify dev` with DEV_AUTH=true: you pick a name, no real sign-in.
window.KITTY_CONFIG = {
  auth: {
    // 'demo': type a name to sign in, no password. Works under `netlify dev` (DEV_AUTH=true),
    //         or on a deployed test site when the DEMO_AUTH=true environment variable is set.
    // 'auth0': real sign-in. Use this before taking live payments.
    mode: 'demo',
    domain: 'YOUR_TENANT.us.auth0.com',
    clientId: 'YOUR_SPA_CLIENT_ID',
    audience: 'https://kitty-api',
  },
};
