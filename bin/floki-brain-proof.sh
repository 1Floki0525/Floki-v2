#!/bin/bash

# Floki-v2 Scaffold Proof Script
# This script verifies that the scaffold structure is properly in place

echo "Checking Floki-v2 scaffold structure..."

# Check required directories exist
REQUIRED_DIRS=(
    "docs"
    "bin"
    "src"
    "src/brain"
    "src/config"
    "src/util"
    "brain"
    "brain/amygdala"
    "brain/broca"
    "brain/cerebellum"
    "brain/emotions_base"
    "brain/frontal"
    "brain/hippocampus"
    "brain/occipital"
    "brain/temporal"
    "brain/thalamum"
    "brain/personality"
    "brain/pineal"
    "tests"
    "state"
    "state/floki"
    "state/floki/memories"
    "logs"
)

for dir in "${REQUIRED_DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
        echo "ERROR: Required directory $dir is missing"
        exit 1
    fi
done

# Check required files exist
REQUIRED_FILES=(
    "README.md"
    "AGENTS.md"
    "package.json"
    ".env.example"
    ".gitignore"
    "docs/ARCHITECTURE.md"
    "docs/STAGE_STATUS.md"
    "bin/floki-brain-proof.sh"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo "ERROR: Required file $file is missing"
        exit 1
    fi
done

# Check brain module structure
BRAIN_MODULES=(
    "brain/amygdala"
    "brain/broca"
    "brain/cerebellum"
    "brain/emotions_base"
    "brain/frontal"
    "brain/hippocampus"
    "brain/occipital"
    "brain/temporal"
    "brain/thalamum"
    "brain/personality"
    "brain/pineal"
)

for module in "${BRAIN_MODULES[@]}"; do
    if [ ! -f "$module/README.md" ]; then
        echo "ERROR: README.md missing in $module"
        exit 1
    fi
    
    if [ ! -f "$module/index.cjs" ]; then
        echo "ERROR: index.cjs missing in $module"
        exit 1
    fi
    
    # Check that index.cjs contains SCAFFOLD_ONLY
    if ! grep -q "SCAFFOLD_ONLY" "$module/index.cjs"; then
        echo "ERROR: SCAFFOLD_ONLY marker missing in $module/index.cjs"
        exit 1
    fi
done

echo "FLOKI_V2_SCAFFOLD_PROOF_PASS"
echo "All scaffold structure requirements verified."