# Color Cup

Draw something. Gemini guesses what it is, then colors each part the way the real thing looks.
The drawing drops into a glass of water, settles, and its color bleeds into the water.

Built with p5.js, three.js, matter.js and the Google Gemini API:

- **p5.js** runs the sketch: drawing, keys, the handwritten text.
- **matter.js** drops each drawing into the glass, using its real outline for collisions.
- **three.js** renders the glass (transmission material), the water, and the color bleeding,
  which is a small watercolor simulation written as shaders.
- **Gemini** names the drawing, then picks the colors of its parts and where they are.

## Deploy on Vercel

1. Put this folder in a GitHub repo, with `index.html` at the top level of the repo.
2. In Vercel, choose **Add New → Project** and import the repo. Framework preset: **Other**. No build command.
3. In **Project → Settings → Environment Variables**, add `GEMINI_API_KEY` with your Gemini key.
4. Deploy. If you added the key after the first deploy, redeploy so the function picks it up.

The key stays on Vercel. The browser only talks to `/api/gemini`, which answers this app's
two questions and nothing else.

## Run it locally

Opening `index.html` directly won't reach Gemini, because the server function isn't running.
Use the Vercel CLI instead:

```
npx vercel link
npx vercel env pull
npx vercel dev
```

`env pull` copies your key into a local `.env.local` file, which `.gitignore` keeps out of GitHub.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Loads p5.js and the four scripts |
| `sketch.js` | Drawing, each drawing's journey, matter.js physics, text |
| `glass.js` | three.js glass, water, and the watercolor simulation |
| `shapes.js` | Outline → filled shape → physics body; color math |
| `gemini.js` | Asks `/api/gemini` the two questions |
| `api/gemini.js` | The server function that holds the key and calls Gemini |

## Controls

Draw, then press **enter** (or tap **drop it in**). **z** undoes a line, **esc** clears, **r** pours the glass out.
