#!/bin/bash
# iCloud → Google Drive for subject materials (fork addition).
# Hermes runs on a server and cannot see iCloud; it can reach Google Drive.
# This copies new or changed files from a subject's iCloud folder into
#   <brain>/LearnHarness/Faecher/<Fach>/Originale/
# in the Drive-synced brain, where Hermes reads them and writes the text
# into Folien/ and Klausuren/ for LearnHarness. Nothing is ever deleted.
#
#   subject-sync.sh add "<Fach>" "<iCloud folder>"   remember a mapping
#   subject-sync.sh remove "<Fach>"                  forget it (files stay)
#   subject-sync.sh list                             show mappings and target
#   subject-sync.sh once                             copy now (the launcher
#                                                    runs this at start and
#                                                    every 15 min while open)
# Mappings: ~/.config/learnharness/subjects.conf ("<Fach><TAB><folder>").
# Brain folder: LH_BRAIN, else the app's setting (Settings → Second Brain).
set -u

CONF_DIR="$HOME/.config/learnharness"
CONF="$CONF_DIR/subjects.conf"
SUBJECTS_REL="LearnHarness/Faecher"

brain_folder() {
	if [ -n "${LH_BRAIN:-}" ]; then echo "$LH_BRAIN"; return; fi
	local f repo
	repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
	# The Dock icon runs `npm run desktop:dev`: its Next server keeps data in
	# the repo's data/ folder. LH_DATA_DIR and the packaged app's profile
	# are the other places the setting can live.
	for f in ${LH_DATA_DIR:+"$LH_DATA_DIR/settings.json"} \
		"$repo/data/settings.json" \
		"$HOME/Library/Application Support/LearnHarness-dev/data/settings.json" \
		"$HOME/Library/Application Support/LearnHarness/data/settings.json"; do
		[ -f "$f" ] || continue
		local folder
		folder="$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const f=s&&s.brain&&s.brain.folder;if(f)process.stdout.write(f.replace(/^~\//,process.env.HOME+"/"))}catch{}' "$f" 2>/dev/null)"
		if [ -n "$folder" ]; then echo "$folder"; return; fi
	done
}

# A subject name becomes a folder name: no slashes, no leading dot.
valid_subject() { [ -n "$1" ] && [[ "$1" != */* ]] && [[ "$1" != .* ]]; }

# Copy one folder: new files, and files newer than the copy. Dotfiles
# (and iCloud's ".name.icloud" placeholders) are skipped.
copy_tree() {
	local src="$1" dest="$2" copied=0 rel target
	# Evicted iCloud files: ask macOS to bring them down first (no-op elsewhere).
	if command -v brctl >/dev/null 2>&1; then brctl download "$src" >/dev/null 2>&1 || true; fi
	while IFS= read -r -d '' file; do
		rel="${file#"$src"/}"
		target="$dest/$rel"
		if [ ! -e "$target" ] || [ "$file" -nt "$target" ]; then
			mkdir -p "$(dirname "$target")"
			if cp -p "$file" "$target"; then copied=$((copied + 1)); echo "  copied: $rel"; fi
		fi
	done < <(find "$src" -type f ! -path '*/.*' -print0)
	echo "  $copied file(s) copied"
}

case "${1:-once}" in
	add)
		subject="${2:-}"; folder="${3:-}"
		valid_subject "$subject" || { echo "usage: $0 add \"<Fach>\" \"<iCloud folder>\"" >&2; exit 2; }
		[ -d "$folder" ] || { echo "Folder not found: $folder" >&2; exit 1; }
		mkdir -p "$CONF_DIR"
		touch "$CONF"
		grep -v "^${subject}	" "$CONF" >"$CONF.tmp" || true
		printf '%s\t%s\n' "$subject" "$folder" >>"$CONF.tmp"
		mv "$CONF.tmp" "$CONF"
		echo "Saved: $subject ← $folder"
		;;
	remove)
		[ -f "$CONF" ] && { grep -v "^${2:-}	" "$CONF" >"$CONF.tmp" || true; mv "$CONF.tmp" "$CONF"; }
		echo "Removed: ${2:-} (copied files stay in the brain)"
		;;
	list)
		brain="$(brain_folder)"
		echo "Brain: ${brain:-(not set — Settings → Second Brain)}"
		[ -s "$CONF" ] || { echo "No subjects yet. Add one: $0 add \"IntSec\" \"/path/to/iCloud/IntSec\""; exit 0; }
		while IFS=$'\t' read -r subject folder; do
			[ -n "$subject" ] && echo "  $subject ← $folder  →  ${brain:-?}/$SUBJECTS_REL/$subject/Originale/"
		done <"$CONF"
		;;
	once)
		[ -s "$CONF" ] || exit 0
		brain="$(brain_folder)"
		if [ -z "$brain" ] || [ ! -d "$brain" ]; then echo "subject-sync: brain folder not set or not found" >&2; exit 1; fi
		while IFS=$'\t' read -r subject folder; do
			valid_subject "$subject" || continue
			if [ ! -d "$folder" ]; then echo "subject-sync: $subject: folder not found: $folder" >&2; continue; fi
			echo "subject-sync: $subject"
			copy_tree "$folder" "$brain/$SUBJECTS_REL/$subject/Originale"
		done <"$CONF"
		;;
	*)
		echo "usage: $0 add|remove|list|once" >&2
		exit 2
		;;
esac
