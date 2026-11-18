# Life Diary, web version (0.1)

The same diary as the Android app, built as a web page that works on any phone, including iPhones. It can be added to the home screen so it opens like an app and works without a connection.

- The diary is stored **on the phone**, in the browser's own database.
- Weights can be shown and entered in **kilograms or pounds** (Trackers > Weight unit). They are always stored in kilograms, so switching never changes them.
- Activities are picked from a list of common ones, or typed under **Other…**; durations from 15 min, 30 min, 1 h, 1 h 30 min and 2 h, or typed (45, 1:15, 1h 20).
- A meal can have a **photo**, taken with the camera or picked from the gallery, with or without text. Photos are shrunk to about 1280 pixels (typically 100 to 300 KB each) before they are stored.
- Each person can sign in to an **online account**, which keeps the diary and its photos safe and in step across devices (see section 3).
- The web host only serves the app's files. No diary data is ever sent to it.

Nothing needs to be built or installed.

## 1. Where it lives

This repository is the whole app, published with GitHub Pages at:

**https://liorc1987.github.io/Lifestyle-Diary/**

To switch Pages on (once): Settings > Pages > Build and deployment > Source: **Deploy from a branch**, branch **main**, folder **/ (root)**. To publish a new version, commit the changed files to `main`; the site updates within a minute or two. When `index.html` changes, also raise the number in `var CACHE = 'life-diary-v2'` in `sw.js`, so installed copies pick up the new version promptly.

Keep the address the same once people use it. A phone stores the diary under that exact address, so a new address starts with an empty diary (signing in, or a backup file, carries it across).

The repository is public, which GitHub requires for free Pages. It holds only the app's code: no diary data is ever stored here.

## 2. Put it on a phone

Open the address in the phone's browser, then add it to the home screen:

- **iPhone:** open it in Safari, tap the Share button, then **Add to Home Screen**. Always use the home-screen icon afterwards. This matters: an iPhone can erase data from pages that are only opened in a Safari tab and not visited for a week.
- **Android:** in Chrome, open the menu and choose **Add to Home screen** or **Install app**.

## 3. Online accounts (Supabase)

Each person can sign in with an email and a password (Trackers > Online account). The diary and its photos are then saved online a few seconds after every change, and come back on any device signed in to the same account. The phone keeps a working copy, so the app also works offline and catches up later.

- **Where it is kept:** a Supabase project owned by whoever hosts the app. The table `diaries` holds one row per person, and the private bucket `photos` holds each person's photos in a folder named after their account. Database rules let each signed-in person read and write only their own row and folder.
- **Who can see it:** each person only their own diary. The owner of the Supabase project can see everything in the Supabase dashboard.
- **Settings:** `config.js` holds the project address and its public (publishable) key. Never put a secret or service-role key there.
- **Approval:** anyone can create an account, but a new account waits for the admin's approval (`supabase/approvals.sql`, run once after `setup.sql`). Until then nothing is saved online and Claude summaries are off; the person's entries stay on their phone and are saved online by themselves once approved. The admin (the account with the email named in `approvals.sql`) sees a banner when someone is waiting, and approves, turns down or takes back accounts under Trackers > Online account > **Manage accounts**. The database checks every request, so the app's screens are only a convenience.
- **Sign-up:** no email is sent ("Confirm email" is switched off in Supabase), because Supabase's built-in email only reaches the project owner's team. A forgotten password is reset by the project owner in the Supabase dashboard (Authentication > Users).
- **Signing out** removes the diary from that device; it stays in the account.
- **Free plan:** Supabase pauses a free project after a week with no use. Nothing is lost; the owner switches it back on in the dashboard.

## 4. Summaries from Claude

On the Summary tab, choose day, week or month, then **Share report** (or **Copy report**). The report is a Markdown file with instructions for Claude, the figures the app calculated, and the period's entries. Send it to the Claude app and Claude replies with what stood out and what is worth trying.

- The report also asks Claude to spot sweets in your meals (from the text, and the photos when they are included) and to compare your mood on days with and without them, and on the day after. Claude names the sweets it counted, so you can correct it. Log snacks and desserts as meals, with a word or a photo, for this to work.
- A **day** report is shared together with that day's meal photos, so Claude can see the meals. Week and month reports carry text only and note which meals have a photo.
- Phones differ in what their share sheet accepts. The app tries, in order: Markdown file with photos, plain-text file with photos, photos with the report as message text, then the same without photos, and says so if the photos had to be left out.
- On a computer, or wherever the browser cannot share files, the report and the day's photos are downloaded as separate files. Attach all of them in Claude.
- **Download as zip** saves the report and all of the period's meal photos (day, week or month) as one zip file, which is handy for keeping. To send to Claude, separate files work best, because Claude looks at photos attached as images, which it may not do for pictures inside a zip.

## 5. Backups and the Android app

Trackers > **Back up diary** saves everything to one file; **Restore from backup** loads it. When the diary has meal photos, the backup asks whether to include them: with photos the file is complete but larger.

The file format is the same as the Android app's, so a diary can move between the two in either direction. The Android app (version 0.1) ignores photos.

## What was tested, and what was not

Tested here in desktop Chrome at phone size, 170 automated checks in total:

- Every screen: entering, editing and deleting entries, custom trackers, the calendar, charts, the weight trend, the report, backup and restore, the phone's Back button, and reopening with the host unreachable.
- Meal photos: choosing, shrinking, showing, replacing and removing them, photo-only meals, backup and restore with photos, and what the report sends under four different kinds of share sheet.
- Online accounts against a stand-in for Supabase: creating an account and signing in, mistakes, automatic saving, a second device receiving the diary and its photos, both-changed conflicts, expired and lost sign-ins, offline use, a second person seeing only their own diary, and signing out.
- A newly published version being picked up and loaded by itself.

Not tested:

- **A real iPhone or Android phone**, including its camera and its real share sheet.
- **The real Supabase service.** The requests follow Supabase's documented interfaces, but the first real sign-in is the true test.
