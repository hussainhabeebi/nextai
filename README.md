# NextAi Accountant

Astro static landing page with Tailwind CSS, built for Cloudflare Pages.

## Development

Node 22 LTS recommended.

```sh
npm install
npm run dev
npm run build
```

## Cloudflare Pages

Connect `hussainhabeebi/nextai`, production branch `main`, framework Astro.
Build command: `npm run build`. Output directory: `dist`.
Set `NODE_VERSION=22`. Add the custom domains `nextaierp.com` and optionally `www.nextaierp.com` in Pages after the deployment succeeds.

Copy `.env.example` values into Pages environment variables. Set a real `PUBLIC_WHATSAPP_NUMBER` (international digits only). The placeholder deliberately does not open an invalid chat. Set `PUBLIC_SIGNUP_ENDPOINT` when the backend is ready. Rebuild after changing public environment variables.

The signup API must accept cross-origin JSON POSTs from the production domain. Payload:

```json
{"businessName":"ABC Traders","phone":"+919876543210","country":"IN","language":"en","utm":{"utm_source":"example"}}
```

Return a non-2xx status for errors. Only return 2xx once onboarding has been accepted and the promised WhatsApp message has been dispatched. Implement rate limiting, duplicate handling and appropriate consent retention on the backend. No server or WhatsApp sending integration is implemented in this static project.

## Before commercial launch

- Connect the API and the business WhatsApp number.
- UAE monthly pricing: Base AED 99 (1 user), Growth AED 299 (4 users), Pro AED 599 (10 users). India prices remain placeholders; confirm plan scope before launch.
- Replace draft privacy and terms pages with approved content.
- Confirm service/security promises reflect the actual service.
- Add approved Malayalam and Arabic translations in `src/config.ts`. The locale routes currently display English with an explicit translation notice; Arabic uses RTL. Source-English strings can be used as translation keys. The three language pages preserve UTMs.
- Run Lighthouse on the deployed domain under mobile throttling; no performance score is claimed from an unmeasured local build.

## Analytics

Listen for `nextai:analytics` on `window`. Its `detail` includes event, placement/plan where applicable, and campaign parameters. Events: `cta_click`, `whatsapp_click`, `signup_submit`, `signup_success`, `signup_error`. No business name or phone number is sent to this hook. Wire your analytics provider with appropriate consent.

## Assets and accessibility

The user-supplied NextAi brand sheet is rendered through CSS viewports, preserving its logo artwork. The phone/chat and line icons are original HTML/SVG illustrations. No WhatsApp logo is used. The page supports keyboard navigation, native dialog focus handling, inline validation, reduced motion and native FAQ accordions. System Noto Sans fonts are preferred, avoiding blocking font downloads.

`docs/wireframe.md` describes the mobile layout. `docs/final-copy.md` contains the English page copy.
