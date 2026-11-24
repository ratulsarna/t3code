# Advancing past review

The walkthrough, QA and close-out need a clean review of the current head. When only docs or comments changed since the clearing review, read the delta and record the skip with `t3 pipeline review waive --reason "<why>"`. Read `t3 pipeline review show` for the current review status.

**Comment pass**, once, when the review rounds are done: before the walkthrough in manual, before QA otherwise. Run `t3 pipeline review start --kind comment`. The owning worker applies its deletions and cuts, and the lead reads that delta. Its reshapes go in the ledger as optional and are not taken. Comments that later fixes add or change get the lead's read.
