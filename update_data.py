"""
Regenerates the schedule data embedded inside index.html, from the Excel file.

Run this every time the Excel file is edited, then redeploy (see README.md).

Requires: pip install openpyxl

Usage:
    python update_data.py "path/to/הסעות דבירה תשפז - לוח משובץ.xlsx"
"""
import sys
import re
import json
import openpyxl

ROSTER_SHEET = "רשימת ילדים והורים"
SCHEDULE_SHEET = "לוח הסעות מוצע"
COUNT_SHEET = "ספירת הסעות למשפחה"


def norm(x):
    """Trim, collapse repeated spaces, and drop invisible direction marks, so a
    stray double space or hidden character can't break a name match."""
    if x is None:
        return ""
    s = re.sub(r"[\u200e\u200f\u202a-\u202e\u00a0]", " ", str(x))
    return re.sub(r"\s+", " ", s).strip()


def build_phone_lookup(wb, family_display_names):
    """
    For each family display name already listed in the count tab (which is
    the single source of truth for "LastName - Father/Mother"), finds that
    family's phone numbers by matching the Father/Mother portion directly
    against the roster's father/mother columns.

    Deliberately does NOT re-derive any family's last name from scratch --
    splitting a combined "LastName FirstName" string is inherently
    ambiguous (that's exactly the bug this replaced), so instead this
    matches on the parent names, which are unambiguous columns in the
    roster.
    """
    ws = wb[ROSTER_SHEET]
    rows = list(ws.iter_rows(min_row=2, max_row=ws.max_row, values_only=True))
    students = []
    for r in rows:
        if r[0] is None:
            continue
        students.append({
            "father": norm(r[3]), "father_mobile": norm(r[4]),
            "mother": norm(r[5]), "mother_mobile": norm(r[6]),
        })

    phones = {}
    for display in family_display_names:
        if " - " not in display:
            continue
        rest = display.split(" - ", 1)[1]
        parts = rest.split("/")
        name1 = parts[0].strip() if len(parts) > 0 else ""
        name2 = parts[1].strip() if len(parts) > 1 else ""

        name1, name2 = norm(name1), norm(name2)

        # 1) best case: both parent names match the same roster row
        matches = []
        if name2:
            matches = [s for s in students if s["father"] == name1 and s["mother"] == name2]
        # 2) fallback: any row where one of the named parents matches
        #    (also covers a single name, or father/mother entered in swapped columns)
        if not matches:
            names = {n for n in (name1, name2) if n}
            matches = [s for s in students if s["father"] in names or s["mother"] in names]

        fmob = next((m["father_mobile"] for m in matches if m["father_mobile"]), "")
        mmob = next((m["mother_mobile"] for m in matches if m["mother_mobile"]), "")
        phones[display] = " / ".join(p for p in [fmob, mmob] if p)

    return phones


def main():
    if len(sys.argv) != 2:
        print("Usage: python update_data.py <path-to-xlsx>")
        sys.exit(1)

    xlsx_path = sys.argv[1]

    # data_only=True reads the last-saved calculated values. If you edited the
    # file in Excel/Google Sheets/LibreOffice and saved it, those values are
    # already there. If you edited it with a tool that doesn't calculate
    # formulas (e.g. wrote cells with openpyxl directly), open and save the
    # file once in Excel/LibreOffice first so the formula results are cached.
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)

    ws = wb[SCHEDULE_SHEET]
    rows = list(ws.iter_rows(min_row=2, max_row=ws.max_row, values_only=True))
    schedule = []
    for date, shift, b1, b2, b3, car in rows:
        if date is None:
            continue
        schedule.append({
            "date": date.strftime("%Y-%m-%d") if hasattr(date, "strftime") else str(date),
            "shift": shift,
            "bus1": b1,
            "bus2": b2,
            "bus3": b3,
            "car": car,
        })

    ws3 = wb[COUNT_SHEET]
    fam_rows = list(ws3.iter_rows(min_row=2, max_row=ws3.max_row, values_only=True))
    families = sorted(set(r[0] for r in fam_rows if r[0]))

    phones = build_phone_lookup(wb, families)
    # only keep phone entries relevant to current families (keeps the payload tidy)
    phones = {name: phones.get(name, "") for name in families}

    unmatched = [name for name, p in phones.items() if p == "" and name not in phones]
    data = {"schedule": schedule, "families": families, "phones": phones}
    json_str = json.dumps(data, ensure_ascii=False, indent=2).replace("</", "<\\/")

    with open("index.html", encoding="utf-8") as f:
        html = f.read()

    pattern = re.compile(
        r'(<script id="schedule-data" type="application/json">\n)(.*?)(\n</script>)',
        re.S
    )
    if not pattern.search(html):
        print("Could not find the embedded data block in index.html -- "
              "make sure you're running this in the same folder as the "
              "original index.html.")
        sys.exit(1)

    html = pattern.sub(lambda m: m.group(1) + json_str + m.group(3), html, count=1)

    with open("index.html", "w", encoding="utf-8") as f:
        f.write(html)

    no_phone = sum(1 for p in phones.values() if not p)
    print(f"Updated index.html: {len(schedule)} schedule rows, {len(families)} families "
          f"({no_phone} with no phone number on file)")

    missing = [name for name in families if name not in phones or not phones[name]]
    if missing:
        print("No phone found for:", ", ".join(missing))
        # Shows up as a yellow warning on the GitHub Actions run page
        print("::warning title=Families with no phone number::" + ", ".join(missing))


if __name__ == "__main__":
    main()
