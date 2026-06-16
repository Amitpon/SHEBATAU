# References - Masked Autoencoders (MAE) Model

---

## Foundation Papers

### 1. Fani et al. 2025 - CV Masking for EHR Foundation Models
**Title:** Continuous Value Masking for EHR Foundation Models  
**Authors:** Fani et al.  
**Source:** https://arxiv.org/pdf/2512.05216  
**Year:** 2025

**Used for:**
- Foundation paper for the masked autoencoder approach applied to electronic health record sequences
- CV masking strategy: masking continuous lab values during pre-training forces the model to reconstruct them from clinical context
- Architecture inspiration: Transformer encoder-decoder with token-type embeddings for EHR data
- Justification for treating each lab measurement as a typed token (lab_history, vital, medication, etc.)
