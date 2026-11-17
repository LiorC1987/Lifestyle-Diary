# Life Diary, web version (0.1)

The same diary as the Android app, built as a web page that works on any phone, including iPhones. It can be added to the home screen so it opens like an app and works without a connection.

- The diary is stored **on the phone**, in the browser's own database.
- A meal can have a **photo**, taken with the camera or picked from the gallery, with or without text. Photos are shrunk to about 1280 pixels (typically 100 to 300 KB each) before they are stored.
- Optionally, each person can link **their own Google Drive**, and the app keeps a copy of the diary and its photos there.
- The web host only serves the app's files. No diary data is ever sent to it.

Nothing needs to be built or installed.

## 1. Where it lives

This repository is the whole app, published with GitHub Pages at:

**https://liorc1987.github.io/Lifestyle-Diary/**

To switch Pages on (once): Settings > Pages > Build and deployment > Source: **Deploy from a branch**, branch **main**, folder **/ (root)**. To publish a new version, commit the changed files to `main`; the site updates within a minute or two. When `index.html` changes, also raise the number in `var CACHE = 'life-diary-v2'` in `sw.js`, so installed copies pick up the new version promptly.

Keep the address the same once people use it. A phone stores the diary under that exact address, so a new address starts with an empty diary (a backup file or Google Drive carries it across).

The repository is public, which GitHub requires for free Pages. It holds only the app's code: no diary data is ever stored here.

## 2. Put it on a phone

Open the address in the phone's browser, then add it to the home screen:

- **iPhone:** open it in Safari, tap the Share button, then **Add to Home Screen**. Always use the home-screen icon afterwards. This matters: an iPhone can erase data from pages that are only opened in a Safari tab and not visited for a week.
- **Android:** in Chrome, open the menu and choose **Add to Home screen** or **Install app**.

## 3. Switch on Google Drive (optional)

Without this step the app works fully, and the Google Drive card says it is not set up.

Google requires whoever hosts the app to register it once. It is free and takes about ten minutes. Google's screens change from time to time, so names may differ slightly.

1. Go to console.cloud.google.com, sign in, and create a **new project** (any name).
2. In **APIs & Services > Library**, find **Google Drive API** and press **Enable**.
3. Open **Google Auth Platform** (formerly "OAuth consent screen") and fill in the basics: an app name, your email address, and audience type **External**.
4. Under **Audience**, add the Gmail address of each person who will use Drive sync (yours and your sister's) as **test users**.
5. Under **Clients**, create a client of type **Web application**:
   - **Authorized JavaScript origins:** `https://liorc1987.github.io` (no folder, no slash at the end)
   - **Authorized redirect URIs:** `https://liorc1987.github.io/Lifestyle-Diary/` (with the folder and the slash at the end)
6. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`).
7. Open `config.js` (here on GitHub: the file, then the pencil icon), paste the ID between the quotes after `googleClientId:`, and commit.

In the app, Trackers > **Connect Google Drive** then takes each person through Google's sign-in.

### Testing mode or published

A new Google project starts in **Testing** mode:

- Only the test users you listed can connect.
- Google shows them a "Google hasn't verified this app" notice, which they continue past.
- Google makes them approve again every 7 days.

That is fine for trying it out. To remove the weekly approval, press **Publish app** on the Audience page. The app only asks for Google's narrowest Drive permission (files the app itself created), which Google classes as non-sensitive, so no review is needed to publish; Google's sign-in screen will not show the app's name until you also complete its optional brand verification.

### How syncing behaves

- The app creates a folder called **Life Diary** in the person's Drive, holding `life-diary.json` and one JPEG file per meal photo. It cannot see anything else in their Drive.
- After each change, the app uploads the diary a few seconds later. Each photo is uploaded once, as its own file, so the diary file stays small.
- When a meal or its photo is deleted, the photo's file is moved to Drive's bin, where Google keeps it for a while before removing it.
- If a phone loses its stored data but is still linked, the next sync brings the diary and photos back from Drive.
- A Google sign-in obtained this way lasts about an hour. With "Sign in when the app opens" on, the app renews it at start by passing through Google's page for a moment. If Google wants a tap, a banner appears: "Google Drive sync is paused. Tap to sign in and sync." Entries made meanwhile are kept and uploaded after signing in.
- If two devices both changed the diary before syncing, a banner asks which version to keep. The replaced one can be brought back once with Trackers > **Undo last replace**.

## 4. Summaries from Claude

On the Summary tab, choose day, week or month, then **Share report** (or **Copy report**). The report is a Markdown file with instructions for Claude, the figures the app calculated, and the period's entries. Send it to the Claude app and Claude replies with what stood out and what is worth trying.

- A **day** report is shared together with that day's meal photos, so Claude can see the meals. Week and month reports carry text only and note which meals have a photo.
- Phones differ in what their share sheet accepts. The app tries, in order: Markdown file with photos, plain-text file with photos, photos with the report as message text, then the same without photos. Where nothing can be shared, the Markdown file is downloaded.

## 5. Backups and the Android app

Trackers > **Back up diary** saves everything to one file; **Restore from backup** loads it. When the diary has meal photos, the backup asks whether to include them: with photos the file is complete but larger.

The file format is the same as the Android app's, so a diary can move between the two in either direction. The Android app (version 0.1) ignores photos.

## What was tested, and what was not

Tested here in desktop Chrome at phone size, 126 automated checks in total:

- Every screen: entering, editing and deleting entries, custom trackers, the calendar, charts, the weight trend, the report, backup and restore, the phone's Back button, and reopening with the host unreachable.
- Meal photos: choosing, shrinking, showing, replacing and removing them, photo-only meals, backup and restore with photos, and what the report sends under four different kinds of share sheet.
- Google Drive sync against a stand-in for Google's servers: first connection, automatic upload, a second device receiving the diary and its photos, a device that lost its data recovering from Drive, both-changed conflicts, expired and refused sign-ins, and uploads failing while offline.

Not tested:

- **A real iPhone or Android phone**, including its camera and its real share sheet.
- **Real Google sign-in and the real Drive service.** The requests follow Google's documentation, but the first real connection is the true test.
- The weakest point is the Google sign-in step when the app runs from an iPhone home-screen icon. If it fails to return to the app, switch off "Sign in when the app opens" and use the banner, or use backup files, and tell me what happened.
