// Scaffold Contract Test
// This test verifies the scaffold structure is properly in place

const fs = require('fs');
const path = require('path');

function testScaffoldStructure() {
  console.log('Testing Floki-v2 scaffold structure...');
  
  // Check required directories exist
  const requiredDirs = [
    'docs',
    'bin',
    'src',
    'src/brain',
    'src/config',
    'src/util',
    'brain',
    'brain/amygdala',
    'brain/broca',
    'brain/cerebellum',
    'brain/emotions_base',
    'brain/frontal',
    'brain/hippocampus',
    'brain/occipital',
    'brain/temporal',
    'brain/thalamum',
    'brain/personality',
    'brain/pineal',
    'tests',
    'state',
    'state/floki',
    'state/floki/memories',
    'logs'
  ];
  
  for (const dir of requiredDirs) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Required directory ${dir} is missing`);
    }
  }
  
  // Check required files exist
  const requiredFiles = [
    'README.md',
    'AGENTS.md',
    'package.json',
    '.env.example',
    '.gitignore',
    'docs/ARCHITECTURE.md',
    'docs/STAGE_STATUS.md',
    'bin/floki-brain-proof.sh'
  ];
  
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Required file ${file} is missing`);
    }
  }
  
  // Check brain module structure
  const brainModules = [
    'brain/amygdala',
    'brain/broca',
    'brain/cerebellum',
    'brain/emotions_base',
    'brain/frontal',
    'brain/hippocampus',
    'brain/occipital',
    'brain/temporal',
    'brain/thalamum',
    'brain/personality',
    'brain/pineal'
  ];
  
  for (const module of brainModules) {
    if (!fs.existsSync(`${module}/README.md`)) {
      throw new Error(`README.md missing in ${module}`);
    }
    
    if (!fs.existsSync(`${module}/index.cjs`)) {
      throw new Error(`index.cjs missing in ${module}`);
    }
    
    // Check that index.cjs contains SCAFFOLD_ONLY
    const content = fs.readFileSync(`${module}/index.cjs`, 'utf8');
    if (!content.includes('SCAFFOLD_ONLY')) {
      throw new Error(`SCAFFOLD_ONLY marker missing in ${module}/index.cjs`);
    }
  }
  
  // Check that no forbidden content exists
  const forbiddenPatterns = [
    'Minecraft',
    'qwen3-vl',
    'qwen3.5',
    'fake intelligence'
  ];
  
  // Check src files for forbidden content
  const srcFiles = [
    'src/brain/floki-brain.cjs',
    'src/brain/brain-event-schema.cjs',
    'src/brain/brain-output-schema.cjs',
    'src/config/model-config.cjs',
    'src/util/fs-safe.cjs',
    'src/util/jsonl.cjs',
    'src/util/time.cjs',
    'src/util/ids.cjs'
  ];
  
  for (const file of srcFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of forbiddenPatterns) {
      if (content.includes(pattern)) {
        throw new Error(`Forbidden pattern "${pattern}" found in ${file}`);
      }
    }
  }
  
  console.log('✅ All scaffold contract tests passed');
  return true;
}

try {
  testScaffoldStructure();
  process.exit(0);
} catch (error) {
  console.error('❌ Scaffold contract test failed:', error.message);
  process.exit(1);
}