# MAE Token Type Mapping Notes

## Where The Mapping Is Defined

The MAE token/category mapping is defined in:

```text
Modeling/MAE/order_event_dataset.py
```

The important objects are:

```python
TYPE_NAMES = [...]
TYPE_TO_ID = {name: i for i, name in enumerate(TYPE_NAMES)}
```

`TYPE_NAMES` controls the integer `type_id` used by the Transformer token-type embedding.

## Current Type Slots

There are currently 13 token types total, indexed from `0` to `12`:

| type_id | token_type |
|---:|---|
| 0 | target_mask |
| 1 | lab_history |
| 2 | panel_sibling |
| 3 | unrelated_lab |
| 4 | vital |
| 5 | background_disease |
| 6 | medication |
| 7 | imaging |
| 8 | consultation |
| 9 | ecg |
| 10 | echo |
| 11 | dialysis |
| 12 | administrative |

Important: there are 13 categories, but no current `type_id = 13`.

## Adding A New Category

If we add one new category after the current list, it should become:

```text
type_id = 13
```

Do not replace `type_id = 4` unless the intention is to overwrite `vital`.

Example:

```python
TYPE_NAMES = [
    "target_mask",
    "lab_history",
    "panel_sibling",
    "unrelated_lab",
    "vital",
    "background_disease",
    "medication",
    "imaging",
    "consultation",
    "ecg",
    "echo",
    "dialysis",
    "administrative",
    "new_category_name",
]
```

## Files That Use This Mapping

```text
Modeling/MAE/order_event_dataset.py
```

Defines `TYPE_NAMES` and `TYPE_TO_ID`.

```text
Modeling/MAE/build_order_event_dataset.py
```

Assigns each engineered feature a string `token_type` in `order_event_feature_registry.csv`.

```text
Modeling/MAE/lab_mae_pipeline.py
```

Reads the feature registry, converts each `token_type` string into `type_id`, and passes `n_types=len(TYPE_NAMES)` into the model.

```text
Modeling/MAE/run_checkpoint_evaluation.py
```

Also uses `TYPE_NAMES` when rebuilding the model for checkpoint evaluation.

## Checkpoint Compatibility

Adding a new token type changes:

```text
n_types: 13 -> 14
```

That changes the shape of the model's token-type embedding layer.

Therefore, old MAE checkpoints may not load cleanly after adding a new category. In practice, adding a new type usually means we should:

1. Update `TYPE_NAMES`.
2. Update the feature registry generation to use the new `token_type`.
3. Update `enabled_token_types` if the new type should be used.
4. Rebuild the order-event dataset/registry if needed.
5. Retrain the MAE model, or explicitly handle partial checkpoint loading.

