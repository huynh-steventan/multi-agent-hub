# DEMO.md — recording the README demo

The README's demo GIF is the artifact that does the explaining; a paragraph about "a mobile-first
console" is worth much less than eight seconds of a session actually streaming.

## What it has to show, in order

1. **The session list**, with sessions across more than one agent — that is the thesis in one frame.
2. **Starting a session**: the new-session sheet, picking an agent and a repo.
3. **A prompt sent, and output streaming in** — the load-bearing shot. Let it run long enough that a
   tool call appears and expands.
4. **The usage strip**, expanded, showing pace bars for all three agents.
5. Optionally the turn-end notification arriving.

Keep it 60–90 seconds. Record the **phone-width** layout: it is the differentiator, and a desktop
capture looks like every other web app.

## How

- Real repo, real turn. A staged transcript is both dishonest and obvious.
- Use a scratch repo with nothing private in it. **Check the frame for repo names, hostnames, the
  tailnet URL in the address bar, and notification banners** before publishing — the address bar in
  particular will show your MagicDNS name.
- macOS: `Cmd+Shift+5` to record the window, or run the browser at 390×844 via devtools device mode.
- Convert to a GIF sized for GitHub (under ~10 MB, or it will not autoplay pleasantly):

  ```sh
  ffmpeg -i demo.mov -vf "fps=12,scale=390:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
    -loop 0 docs/demo.gif
  ```

  An `.mp4` uploaded directly into the README via the GitHub web editor is also fine and usually
  looks better; GitHub renders it inline with controls.

## Record from the home-screen icon, not from Safari

Add to Home Screen first, then record by launching from that icon. The page declares the iOS
web-app meta tags, so it opens with **no browser chrome at all**.

This is not cosmetic. Recording in Safari puts your host name on screen in two places, and only one
of them can be cropped:

1. The address bar at the bottom of every frame — croppable.
2. A small URL hint centered directly above the keyboard, visible whenever the keyboard is up —
   **not** croppable, because it sits in the middle of the frame. Worse, it slides in and out with
   the keyboard, so masking it means tracking a moving target across the transition.

The shipped GIF was recorded in Safari and needed exactly that: a `delogo` patch over the hint's
resting position while the keyboard is settled, plus a `boxblur` band covering its full travel
during the ~0.5s slide animations. It works, but it is about twenty minutes of frame-by-frame
verification that launching from the home screen avoids entirely.

Point `REPO_ROOTS` at a directory with no username in its path — `/Users/Shared/...` rather than
your home directory. Then no path the picker displays, and none the agent prints when it runs `pwd`,
can leak the identifier. Do this instead of trying to avoid prompts that make agents print paths;
removing the string beats remembering not to say it.

## Then

Put the GIF at `docs/demo.gif` and embed it near the top of the README. Confirm what it shows still
matches what the README claims — a demo that contradicts the feature list is worse than no demo.

Before publishing, sweep the finished file rather than spot-checking it:

```sh
# every 0.2s through a suspect stretch, tiled into one contact sheet
for t in $(seq 6 0.2 12); do
  ffmpeg -v error -ss "$t" -i docs/demo.gif -frames:v 1 -vf "scale=190:-1" "/tmp/f/$t.png" -y
done
ffmpeg -v error -pattern_type glob -i '/tmp/f/*.png' -vf tile=10x3 -frames:v 1 /tmp/sheet.png -y
```
