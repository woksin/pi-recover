# Changelog

## 0.1.1

### Changed
- After `/reload`, warns about subagents that were lost in the reload. Jobs kept across the reload are protected from recovery cleanup.
- Reload notices only list agents that are still open, and job identity is checked before a job is reported as retained.

## 0.1.0

- First release.
