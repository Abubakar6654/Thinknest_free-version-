# ThinkNest (website + API in one project)

## Run on your computer
1. Install Node.js (LTS) from nodejs.org
2. In this folder: `npm install`
3. Copy `.env.example` to `.env` and fill it in
4. `npm start`  ->  open http://localhost:3000

## Go live (Render)
1. Upload this folder's files to a private GitHub repo (never upload `.env`).
2. Render -> New -> Web Service -> pick the repo. Build: `npm install`  Start: `npm start`. Instance: Starter (paid).
3. Add a Disk (mount path `/var/data`, 1 GB).
4. Environment: JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, PAYSTACK_SECRET_KEY, ANTHROPIC_API_KEY, DB_PATH=/var/data/thinknest.db
5. Deploy, then open your onrender.com address: that is the whole site.
6. Paystack dashboard -> Settings -> API Keys & Webhooks -> webhook URL: https://YOUR-SITE/api/webhooks/paystack

## All-free version (no payments)
Set the environment variable `FREE_MODE=true` and every Premium feature is unlocked for everyone:
full AI tutor, personalized learning path and premium lessons. Payments are switched off and the pricing section is hidden.
`PAYSTACK_SECRET_KEY` is not needed. Optional: `TUTOR_DAILY_LIMIT=30` caps each student's tutor chats per day to control your Anthropic costs (default: unlimited).
Run it as its own Render service with its own database, so it never mixes with the paid version.
