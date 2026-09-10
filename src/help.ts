export const VISUAL_CONTEXT_HELP = `pi-visual-context

Usage:
  @v file.rs -- question
  @v foo.h foo.c -- question
  @v src/**/*.py -- question

Visual prompt (opt-in):
  @v --visual-prompt src/**/*.py -- long question
  @v --visual-prompt -- long question
  Render the task as visual tablets; short prompts are usually better as text.

Preview:
  @v --render src/**/*.py
  @v --render --open src/**/*.py
  @v --visual-prompt --render src/**/*.py -- long question

Profiles:
  @v --profile conservative file.py -- question
  normal | conservative

Languages: .rs .c .h .py (other files: generic UTF-8 text fallback)
Navigation in the current source context:
  @v --tablet PREFIX-VC-000123 -- question
  @v --symbol Executor.run -- question
  Navigation references tablets already attached; it does not resend images.
  One source context is allowed per conversation.

Options: --visual-prompt  --render  --open  --profile conservative  --tablet  --symbol

Environment:
  PI_VISUAL_CONTEXT_CONFIRM_FILES
  PI_VISUAL_CONTEXT_MAX_TABLETS
  PI_VISUAL_CONTEXT_SHOW_USAGE
  PI_VISUAL_CONTEXT_CACHE
  PI_VISUAL_CONTEXT_RASTER_WORKERS`;
