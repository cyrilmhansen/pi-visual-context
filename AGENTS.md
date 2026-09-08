# Agent instructions

This project is intentionally small.

Before writing new code:

1. Inspect the repository for an existing reusable implementation.
2. Extend an existing component rather than creating a new one-off script.
3. If an operation has already been implemented twice, factor it into a
   reusable component before implementing it again.
4. Experiment-specific code should primarily be configuration.
5. Do not duplicate rendering, source compaction, image attachment, target
   localization, or process-execution logic.
6. Do not refactor unrelated working code.
7. Keep the implementation minimal until the end-to-end Pi extension works.
