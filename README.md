```markdown
# 🚀 CommitStory 
> **Transform Git Diffs into Interactive Architecture Maps & Stakeholder Release Notes**

[![Built with Gemini 1.5 Flash](https://img.shields.io/badge/Built_with-Gemini_1.5_Flash-8A2BE2?style=for-the-badge&logo=google)](https://ai.google.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-18.x-43853D?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 💡 The Problem
Engineers spend hours writing PR descriptions and changelogs. Meanwhile, Product Managers and business stakeholders struggle to understand what code changes actually mean for the product's architecture. There is a massive communication gap between the terminal and the boardroom.

## ✨ Our Solution
**CommitStory** bridges this gap using Google's Gemini 1.5 Flash. It instantly analyzes Git diffs and outputs two things:
1. **A dynamic, visual Mermaid.js architecture map** showing exactly how modified modules interact.
2. **Non-technical release notes** tailored for business stakeholders.

---

## 🛠️ Tech Stack & Architecture
This project was built for **GDG DevHack**, leveraging the Google ecosystem and modern web tools:

* **AI Engine:** Google Gemini 1.5 Flash (`@google/genai` SDK) – We rely on Gemini's **Structured Output (JSON schema)** to strictly enforce valid Mermaid.js syntax without hallucinated markdown blocks.
* **Backend / CLI:** Node.js (ES Modules), Express.js, Commander.js.
* **Frontend UI:** HTML5, Tailwind CSS (CDN), Mermaid.js (live browser rendering).
* **Version Control Integration:** Native Git (`child_process`), GitHub REST API (`@octokit/rest`).
* **CI/CD Automation:** GitHub Actions & `github-script` for automated PR commenting.

---

## 🚀 Quick Start Guide

### Prerequisites
* Node.js v18+
* A [Google Gemini API Key](https://aistudio.google.com/app/apikey)
* A GitHub Personal Access Token (for extended API limits)

### 1. Run the Web Dashboard
```bash
git clone https://github.com/mayank5-cmd/CommitStory.git
cd CommitStory

# Install dependencies
npm install

# Setup Environment Variables
echo "GEMINI_API_KEY=your_key_here" > .env
echo "GITHUB_TOKEN=your_token_here" >> .env

# Start the Express server
npm start

```

Visit `http://localhost:3000` in your browser.

### 2. Run the CLI Tool Locally

```bash
# Link the package globally
npm link

# Export your API key
export GEMINI_API_KEY="your_key_here"

# Run it on any local git repository!
commitstory --compare main..feature-branch

```

### 3. Add to Your Repos (GitHub Actions)

Drop our workflow file into your repository `.github/workflows/commitstory.yml` to automate your Pull Request visual comments!

---

## 📄 License

This project is open-source under the [MIT License](https://www.google.com/search?q=LICENSE).

---

*Built with ❤️ and ☕ for GDG DevHack.*

```

```
