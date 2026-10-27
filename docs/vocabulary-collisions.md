# Words collision diagnostics

On the Words page, when a correction or text shortcut shares a complete trigger with another
saved rule, the editor explains which draft trigger collided, the existing
rule's kind and name, and its saved trigger. Alternative triggers are checked
as well as the primary trigger of a shortcut. Both spellings are shown for
case-insensitive or Unicode simple-folding matches, such as `ſ` and `s`.

Disabled rules still reserve their triggers; the message labels them disabled.
Edit the named rule or choose a distinct trigger before saving. Editing a rule
does not collide with its own ID. If old saved data has several collisions, the
first conflicting saved rule is reported; resolve it to see any remaining
collision. Corrections' output text is not itself a trigger.

The same diagnostic is used when remembering a correction from a transcript.
Blocked saves and cancelled editors do not change saved rules, transcript
content or settings. Changing a rule affects future clean output; original
speech and saved transcript content stay intact.

The matching policy: whole literal triggers, Unicode simple case folding, no
accent normalization and no substring matching. `cargo test -p delulu-domain
personalization` checks that conflicts and aliases use Unicode simple folding.
