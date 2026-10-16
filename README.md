# 404 Mentor

Explains code errors in plain language, on hover, in VS Code. Runs entirely on your machine when paired with Ollama. Teaches you the underlying concept so you stop making the same mistake.

## Features

- **Hover any error** for a plain-English explanation: what went wrong, why, how to fix it, and the idea behind it
- **Adapts to your skill level** — from "never coded before" to "expert"
- **Teaches from repetition** — the more you make the same mistake, the more concrete the explanation becomes
- **Finds logic bugs** — patterns like `if (x = 5)`, off-by-one loops, missing returns in `.map()`
- **Fix all** — repairs errors and warnings in the active file, safely and undoably
- **Multiple AI providers** — Ollama local, Ollama Cloud, OpenAI, Anthropic, Gemini, or any OpenAI-compatible endpoint
- **Runs offline** with Ollama — your code never leaves your machine

## Setup

1. Install [Ollama](https://ollama.com) and pull a model:

2. Install this extension.
3. Open any `.js` or `.ts` file. Hover a red squiggle.

Or skip Ollama and use an online provider (OpenAI, Anthropic, Gemini). Run **404: Set API Key** from the command palette.

## Privacy

With Ollama, everything runs on your machine. No code is sent anywhere. API keys are stored in VS Code's SecretStorage (OS keychain).

## Commands

- **Fix All Errors in File**
- **Scan File for Logic Issues**
- **Explain Error at Cursor**
- **Set Skill Level**
- **Set API Key** / **Clear API Key**
- **Set Advanced Settings Password**
- **Reset Learning Progress**
- **Clear Explanation Cache**

## License

MIT