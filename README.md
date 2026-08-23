# הסעות שישי - דבירה תשפ"ז

A single static HTML file (no backend, no database, no build step) so parents can:
- look up their own family's carpool assignments by name
- pick a Friday and see who's on each bus / driving the car that day, with a phone number next to each name

The schedule data lives inside `index.html` itself (in a small embedded JSON
block), so the page works by simply double-clicking the file - and works the
same way once deployed. Vercel just serves the one file as-is.

## First-time deployment

1. Install Node.js if you don't have it (https://nodejs.org), then install the Vercel CLI:
   ```
   npm i -g vercel
   ```
2. From inside this folder, run:
   ```
   vercel
   ```
   Follow the prompts (log in / create an account, accept the defaults it suggests). This deploys a preview.
3. Ship it live:
   ```
   vercel --prod
   ```
   Vercel prints the live URL - that's the link to send to parents.

That's it - no framework, no config file needed.

## Updating when the Excel changes

After you edit the schedule in Excel and save it:

1. Regenerate the data embedded in the page:
   ```
   pip install openpyxl
   python update_data.py "/path/to/הסעות דבירה תשפז - לוח משובץ.xlsx"
   ```
   This rewrites the data block inside `index.html` in place - everything
   else in the file (layout, styling, logic) stays untouched.
2. Redeploy:
   ```
   vercel --prod
   ```

The live page updates within a few seconds.

(Alternative: if you'd rather not run Python locally, just come back to this
Claude conversation, upload the updated Excel file, and ask for a refreshed
`index.html` - drop the file it gives you into this folder and run `vercel --prod`.)

## Testing locally

Just double-click `index.html` - it opens directly in your browser and works
fully offline, no local server needed.

## Files

- `index.html` - the whole page: markup, styling, logic, and the schedule data, all in one file
- `update_data.py` - regenerates the embedded data from the Excel file
