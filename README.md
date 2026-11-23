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
