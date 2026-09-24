-- EZ scores count ×1.8 by default, the multiplier most tournaments use. Matches still on the old
-- default of 1 move to 1.8; `migrate` then recomputes the costs of matches with EZ scores.
alter table matches alter column ez_multiplier set default 1.8;
update matches set ez_multiplier = 1.8 where ez_multiplier = 1;
