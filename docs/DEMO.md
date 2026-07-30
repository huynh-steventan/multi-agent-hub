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

## Then

Replace the `<!-- DEMO GIF GOES HERE -->` comment near the top of the README with the embed, and
confirm what the GIF shows still matches what the README claims. A demo that contradicts the feature
list is worse than no demo.
