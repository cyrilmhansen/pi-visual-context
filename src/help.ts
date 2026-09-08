export const VISUAL_CONTEXT_HELP = `pi-visual-context

Context:
  @v file.rs -- question
  @v foo.h foo.c -- question
  @v src/**/*.py -- question

Preview:
  @v --render src/**/*.py
  @v --render --open src/**/*.py

Profiles:
  @v --profile conservative file.py -- question
  normal
  conservative

Languages:
  Rust: .rs
  C: .c .h
  Python: .py

Globs:
  *.py
  **/*.py

Variables:
  PI_VISUAL_CONTEXT_CONFIRM_FILES
  PI_VISUAL_CONTEXT_MAX_TABLETS
  PI_VISUAL_CONTEXT_SHOW_USAGE`;
