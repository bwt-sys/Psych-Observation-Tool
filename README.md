# Observation Timer

A standalone, no-build web app for direct behavioural observation sessions. Open `index.html` in any modern browser. It needs no server or build step and makes no network requests; the two export libraries are bundled in `vendor/`. Recorded data stays in the page until you download it.

## Features

- **Session setup:** participant ID, observer, session length (or untimed), interval length, and recording method.
- **Behaviours with hotkeys:**
  - *Event* behaviours count each occurrence (frequency and rate per minute).
  - *Duration* behaviours toggle on and off (bouts, total time, mean bout length, % of session).
- **Interval recording,** scored from the timestamped log once the session ends:
  - *Partial interval:* the behaviour occurred at any point in the interval.
  - *Whole interval:* the duration behaviour was on for the entire interval.
  - *Momentary time sampling:* the duration behaviour was on at the instant the interval ended.

  An incomplete final interval is shown with `*` and left out of interval percentages. Whole-interval and momentary methods apply only to duration behaviours.
- **Interval cues:** a beep, vibration on supported phones, and a flash of the panel.
- **Pause and resume:** the observation clock stops while paused.
- **Undo** for the last behaviour or note entry, and **timestamped notes**.
- **Charts on the results screen:** an on/off pie for each duration behaviour, and one bar chart of counts for all event behaviours. Hover over or tap any slice or bar for exact figures.
- **PDF report:** a formatted, print-ready report with session details, the summary table, both charts, notes, and the interval record (with the header repeated on every page).
- **Excel workbook:** styled *Report*, *Intervals* and *Events* sheets with real time and % number formats, frozen headers, filters, and the charts embedded as pictures.
- **Raw CSV export:** events log, interval score sheet, and per-behaviour summary, for SPSS, R and similar tools. Each file is UTF-8 with a BOM so Excel opens it correctly.
- Keeps the screen awake during recording where the browser supports it. Setup is remembered in the browser between sessions.

## Keyboard

| Key | Action |
| --- | --- |
| behaviour hotkey | record event, or start/stop a duration behaviour |
| <kbd>Space</kbd> | start the timer, then pause / resume |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Z</kbd> | undo last entry |
| <kbd>Enter</kbd> (in note box) | add note |

## Files

- `index.html`, `style.css`, `app.js`: the user interface.
- `logic.js`: pure scoring and formatting functions, shared by the browser and the tests.
- `report.js`: builds the PDF report and the Excel workbook.
- `vendor/`: [jsPDF](https://github.com/parallax/jsPDF) 4.2.1 and [ExcelJS](https://github.com/exceljs/exceljs) 4.4.0 (both MIT; licences alongside). They are loaded only when you click an export button, so the app still starts instantly and works offline.
- `test/logic.test.js`: unit tests. Run them with `npm test` (needs Node 18 or later).
