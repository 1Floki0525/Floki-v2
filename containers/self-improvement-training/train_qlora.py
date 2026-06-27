#!/usr/bin/env python3
"""Floki-v2 RSI QLoRA training entrypoint.

Reads a deterministic training configuration (produced on the host from chat
YAML and mounted read-only), loads the read-only Hugging Face master checkpoint
in 4-bit, attaches a LoRA adapter, trains on the attributable dataset, writes
periodic checkpoints, and saves the candidate adapter plus a metrics file.

This script NEVER trains the production Ollama GGUF and NEVER performs full-weight
fine-tuning: it always uses 4-bit quantization + LoRA (QLoRA). It is designed to
run inside the training container with the RTX 3060 12 GB GPU. CI does not have a
GPU or the checkpoint, so CI verifies this file with `py_compile`; the real GPU
proof happens on the host.
"""

import json
import os
import sys
import time


def load_config():
    config_path = os.environ.get("FLOKI_TRAINING_CONFIG_FILE")
    if not config_path:
        raise SystemExit("FLOKI_TRAINING_CONFIG_FILE is not set")
    with open(config_path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    if config.get("method") != "qlora":
        raise SystemExit("training config method must be 'qlora'")
    if config.get("full_finetune") is True:
        raise SystemExit("full-weight fine-tuning is not allowed")
    if not config.get("quantization", {}).get("load_in_4bit"):
        raise SystemExit("QLoRA requires 4-bit quantization (load_in_4bit)")
    return config


def read_dataset(path):
    records = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            text = record.get("text")
            if text:
                records.append({"text": text})
    if not records:
        raise SystemExit("dataset is empty: " + path)
    return records


def write_metrics(adapter_dir, metrics):
    os.makedirs(adapter_dir, exist_ok=True)
    with open(os.path.join(adapter_dir, "metrics.json"), "w", encoding="utf-8") as handle:
        json.dump(metrics, handle, indent=2)


def main():
    config = load_config()

    # Heavy ML imports happen only at run time (inside the GPU container), so the
    # file remains importable / py_compile-able on machines without these deps.
    import torch  # noqa: WPS433
    from datasets import Dataset  # noqa: WPS433
    from transformers import (  # noqa: WPS433
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
        TrainingArguments,
    )
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training  # noqa: WPS433
    from trl import SFTTrainer  # noqa: WPS433

    quant = config["quantization"]
    compute_dtype = getattr(torch, quant.get("bnb_4bit_compute_dtype", "bfloat16"), torch.bfloat16)

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type=quant.get("bnb_4bit_quant_type", "nf4"),
        bnb_4bit_compute_dtype=compute_dtype,
        bnb_4bit_use_double_quant=bool(quant.get("bnb_4bit_use_double_quant", True)),
    )

    base_path = config["base_model_path"]
    tokenizer = AutoTokenizer.from_pretrained(base_path, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        base_path,
        quantization_config=bnb_config,
        device_map="auto",
        torch_dtype=compute_dtype,
    )
    model = prepare_model_for_kbit_training(model)

    lora = config["lora"]
    peft_config = LoraConfig(
        r=int(lora["r"]),
        lora_alpha=int(lora["alpha"]),
        lora_dropout=float(lora["dropout"]),
        target_modules=list(lora["target_modules"]),
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, peft_config)

    records = read_dataset(config["dataset_path"])
    dataset = Dataset.from_list(records)

    tparams = config["training"]
    adapter_dir = config["adapter_output_path"]
    os.makedirs(adapter_dir, exist_ok=True)

    training_args = TrainingArguments(
        output_dir=adapter_dir,
        per_device_train_batch_size=int(tparams["per_device_train_batch_size"]),
        gradient_accumulation_steps=int(tparams["gradient_accumulation_steps"]),
        learning_rate=float(tparams["learning_rate"]),
        num_train_epochs=float(tparams["num_train_epochs"]),
        max_steps=int(tparams["max_steps"]) if int(tparams["max_steps"]) > 0 else -1,
        warmup_ratio=float(tparams["warmup_ratio"]),
        weight_decay=float(tparams["weight_decay"]),
        lr_scheduler_type=tparams["lr_scheduler_type"],
        optim=tparams["optim"],
        seed=int(tparams["seed"]),
        logging_steps=int(tparams["logging_steps"]),
        save_steps=int(tparams["save_steps"]),
        save_strategy="steps",
        bf16=compute_dtype == torch.bfloat16,
        report_to=[],
    )

    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=int(tparams["max_seq_length"]),
        tokenizer=tokenizer,
    )

    started = time.time()
    train_result = trainer.train()
    elapsed = time.time() - started

    trainer.model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)

    metrics = dict(getattr(train_result, "metrics", {}) or {})
    metrics.update({
        "elapsed_seconds": elapsed,
        "record_count": len(records),
        "seed": int(tparams["seed"]),
        "method": "qlora",
    })
    write_metrics(adapter_dir, metrics)
    print("FLOKI_V2_RSI_TRAINING_COMPLETE " + json.dumps(metrics))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        print("FLOKI_V2_RSI_TRAINING_FAILED " + str(error), file=sys.stderr)
        sys.exit(1)
