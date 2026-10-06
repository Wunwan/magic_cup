# Magic Cup

Draw something and press **enter**. Gemini guesses what you drew, colors each part the
way the real thing looks, and the drawing drops into a glass of water, where its color
bleeds out.

**Live:** https://magic-cup.vercel.app/

## How it works

- **p5.js** for drawing and the sketch loop
- **matter.js** drops each drawing into the cup using its real outline
- **three.js** renders the glass (transmission material) and the watercolor bleeding
- **Gemini** names the drawing, then picks the colors of its parts

## Controls

**enter** drop it in · **z** undo a line · **esc** clear · **r** pour the glass out

## Running it

Deployed on Vercel. Set `GEMINI_API_KEY` in the project's environment variables.
The key stays on the server (`api/gemini.js`) and is never sent to the browser.

<img width="1828" height="1384" alt="image" src="https://github.com/user-attachments/assets/95138e75-72e8-4911-8d03-11f174299f4b" />
