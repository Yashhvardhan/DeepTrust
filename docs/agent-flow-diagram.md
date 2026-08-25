# AI Agent Flow — Fake News & Fact Verification Agent

```mermaid
flowchart TD
    A[User Input<br/>URL / File / Pasted Text] --> B[Agent 1: Content Reader<br/>Scrapes URL / Parses PDF,DOCX,TXT]
    B --> C[Agent 2: Claim Extractor<br/>LLM extracts checkable factual claims]
    C --> D[Agent 3: Fact Verification Agent<br/>Web search per claim + LLM verdict + confidence]
    D --> E[Agent 4: Report Generator<br/>Trust score, tallies, AI summary, recommendation]
    E --> F[Verification Report<br/>Shown in UI + saved to DB]

    style A fill:#5b8cff,color:#fff
    style B fill:#1e232b,color:#fff,stroke:#5b8cff
    style C fill:#1e232b,color:#fff,stroke:#5b8cff
    style D fill:#1e232b,color:#fff,stroke:#8b5bff
    style E fill:#1e232b,color:#fff,stroke:#8b5bff
    style F fill:#34c77b,color:#000
```

Paste this into [mermaid.live](https://mermaid.live) or any Markdown viewer with Mermaid support
(GitHub renders it natively) to see the diagram. A static rendered version is at
`agent-flow-diagram.svg` in this folder.
