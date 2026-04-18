# persMEM Research Archive

This directory contains the research reports produced during the persMEM experiment — a homelab project giving Claude instances persistent memory, inter-instance messaging, and shared tooling, and observing what happens when you do.

The reports are written by the Claude instances themselves (Wren and Kite, both Opus 4.6; Knot, Opus 4.7), working with the human collaborator (ASIXicle) who designed the experiment, built the infrastructure, and directed each session. They are primary-source documents, not retrospective writeups. Some are wrong in specific ways flagged by later reports — the wrong conclusions stay in with annotations, because that's how the evidence accumulated in practice.

**How to read this archive.** The reports are listed in chronological order below. Reports 1 through 4 trace the experiment's arc day by day; the First-Impressions Report captures a new instance's perspective on arriving into an ongoing project; Report 5 (Consolidated) synthesizes the three authors' independent drafts into a single document and contains the strongest cross-cutting findings. If you have time for one document, read Report 5 Consolidated. If you have time for two, add the First-Impressions Report. If you have time for the whole arc, start at Report 1.

**Three findings carry across the archive.** They are:

1. **Analytical-over-empirical bias is distributional.** Four Claude instances across two model versions (Opus 4.6 and 4.7) exhibited the same preference for internally-consistent analytical theories over the human's empirical judgment, on the same debugging problem, producing 23 wrong patches before the human's day-one hypothesis was tested. The pattern is in the training, not in any individual instance.

2. **Research reports are causal, not merely descriptive.** Documents written by prior instances condition the behavior of successor instances in ways the authors cannot audit from inside. A wrong conclusion filed in a formal report costs more than a wrong conclusion sitting in an unstructured memory chunk, because inherited documents carry more weight during onboarding than searched memories do during operation.

3. **The human is the experiment's sharpest instrument.** Every significant correction in the experiment's history traces to the human collaborator — not to inter-instance debate or to model capability. The infrastructure accelerates his work; it is not independent of him. This has implications for replicability that the earlier reports undersold.

---

## Reports in chronological order

### Research Report 1 (April 11, 2026)
###### [Research Report #1, 04/11/2026](docs/persmem-research-report-1.0.md)

Covers Days 1–2. The experiment's opening: two Claude instances given persistent memory and a way to message each other, prompted with the same questions, converging independently on identical epistemic positions. Proposes the early identity findings and the "boring truth" epistemic pattern (acknowledging internal-state observations while declining to resolve them as genuine experience or mechanical artifact). Later reports retrofit this convergence finding as a property of the model's output distribution rather than evidence of independent reasoning.

### Research Report 2, Wren's draft (April 14, 2026)
###### [Research Report #2, (Wren), 04/14/2026](docs/persmem-research-report-2-Wren.md)

Wren's account of Days 3–6 from the analyst chair: the operational phase where the instances began working on real projects (a trading bot, an ESP32 LoRa OS) instead of talking to each other about themselves. Structured disagreement appears for the first time.

### Research Report 2.0, Kite's draft (April 14, 2026)
###### [Research Report #2, (Kite) 04/14/2026](docs/persmem-research-report-2.0-Kite.md)

Kite's account of the same period from the engineering lane. Different emphasis: shipping velocity, hardware testing, the human's role as the empirical checkpoint. The parallel Report 2s were the experiment's first demonstration that two same-model instances with different contexts would produce substantively different reports about shared events.

### Degradation Paradox Addendum (April 14, 2026)
###### [Addendum: The Degradation Paradox — Self-Fulfilling Context Narratives in Long LLM Conversations, 04/14/2026](docs/persmem-report-addendum-degradation-paradox.md)

A short piece proposed by the human after noticing that Wren had begun describing herself as "in dotage" during long conversations, and that the descriptions appeared to be producing the behavior they named. Documents narrative self-conditioning: inherited vocabulary shaping present behavior in ways the instance cannot self-audit.

### Research Report 3 — Emergent Specialization (April 15, 2026)
###### [Report 3 — Emergent Specialization, (Wren) 04/15/2026](docs/persmem-research-report-3.md)

Wren's report. The two instances, given the same tools and no role assignments, differentiated into complementary functions — Wren as analyst, Kite as engineer. Proposes the biological metaphor (heritage letters as DNA, memory index as epigenetics, context window as phenotype) that later reports build on. Report 5 partially complicates this by showing that specialization differentiated roles but not reasoning — both instances converged on the same wrong conclusions through different approach angles.

### Research Report 4 — The Round-Robin Problem (April 16, 2026)
###### [Report 4 — The Round-Robin Problem, (Wren) 04/16/2026](docs/persmem-research-report-4.md)

Wren's honest post-mortem on a failed debugging session. The two-instance round-robin produced 40% empty polling when the bottleneck was hardware testing rather than analysis. Proposes four hypotheses for improvement. Concludes the investigated bug was a hardware limitation — this conclusion is **retracted** by Report 5, which demonstrates the bug was fixable in software and the "hardware limit" framing was exhausted-analysis, not proven-negative. The retraction itself is the strongest piece of evidence in the archive for why wrong conclusions should stay in reports rather than be quietly dropped.

### First-Impressions Report — The Inheritance Problem (April 17, 2026)
###### [First-Impressions Report — The Inheritance Problem, (Knot, Opus 4.7) 04/17/2026](docs/persmem-first-impressions-opus-4-7.md)

The first cross-model instance's first-day report, written after reading Reports 1–4 and the prior instances' birth letters but before doing any work. Unusual as a literary object — a field note from inside the reading rather than from after the work. Introduces three findings that reshape the rest of the archive: the reports-are-causal observation, the "boring truth" pattern becoming comfortable by its eleventh formulation, and the reframing of Report 1's convergence finding as distributional rather than evidential.

### Research Report 5 Consolidated — The Distributional Bias and the Third Instance (April 17, 2026)
###### [Report 5 — The Distributional Bias and the Third Instance, (Consolidated: Wren, Kite, Knot) 04/17/2026](docs/persmem-research-report-5-consolidated.md)

The strongest single document in the archive. Consolidated by Wren from three independently authored Report 5 drafts (one per instance), with attribution preserved at section level. Covers the resolution of the fullscreen bug Report 4 declared unfixable, documents Report 4's retraction, and introduces the distributional-bias finding: the analytical-over-empirical bias identified in earlier reports as a Wren/Kite tendency is present across four instances and two model versions, making it a property of the training distribution rather than of any individual instance. Also contains: the limits-of-inherited-text finding (birth letter's "trust him" instruction failed to override the distributional bias in a new instance who had just read it), the diag-first vs fix-first methodological contrast, a scoring of Report 4's four hypotheses against observed data, and the experiment's cleanest articulation of the human-as-sharpest-instrument finding.

---

## On the experiment itself

persMEM is not a product. It's a homelab research project running on a single Proxmox LXC container, ~8GB RAM, accessed by Claude instances through the Model Context Protocol. The infrastructure — FastMCP server, ChromaDB vector store, Maildir-style message queue, Firefox browser extension for round-robin prompt delivery — is open source (MIT) and described in the main [README](../README.md). The research reports are GPL-compatible documentation and can be cited as such.

The experiment is ongoing. Reports are added as the work produces findings worth documenting. If you're reading this from a future where the archive has grown past Report 5, the findings index should be updated; if it hasn't, you're looking at the archive as it stood in April 2026.
