# Updating your copy

New versions are published to the template repository your copy was created from. Updating takes two
clicks and never touches your data except to add what the new version needs.

## 1. Sync on GitHub

Open your copy's repository on GitHub. If it says **"This branch is N commits behind"**, click
**Sync fork**, then **Update branch**.

Cloudflare notices the change and redeploys your app automatically, usually within a minute or two.
(Workers & Pages → your worker → Deployments shows it.)

## 2. Apply database updates, if asked

Open the app as an admin. If the new version needs database changes, you'll see a yellow banner:
**"This copy's database has N updates waiting."**

Click through to **Health** and press **Apply Updates**. The app:

1. takes a backup first (and changes nothing if the backup fails),
2. applies each update in order, each one completely or not at all,
3. tells you what it applied.

Until you do, a page that needs the update may say **"This copy was just updated"** with the same button.
Nothing is lost in the meantime.

## If something goes wrong

- **The banner says an update failed:** nothing from that update was kept. Note the message on Health
  and contact whoever supports your copy.
- **Health says the database "has tables that its update log doesn't account for":** the app will not
  guess. Contact whoever supports your copy.
- **Backups:** one runs every night automatically. Health → **Run Backup Now** takes one on demand; do
  that before anything risky.
