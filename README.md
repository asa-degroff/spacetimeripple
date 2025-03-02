# Interactive Wavy Grid with WebGPU

A mesmerizing interactive animation that combines a dynamic grid system with Perlin noise to create natural-looking wave patterns. Built using WebGPU shaders for high-performance graphics rendering.

![Demo Preview](demo.gif)

## Features

- 🌊 Smooth, naturally animated grid using Perlin noise
- 🖱️ Interactive ripple effects on mouse drag
- ⚡ High-performance WebGPU shader implementation
- 🖥️ Adaptable viewport size

## Live Demo

[View Live Demo](#) *(Coming soon)*

## Prerequisites

- A browser that supports WebGPU (Chrome Canary with WebGPU flags enabled)
- Node.js and npm installed

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/asa-degroff/spacetimeripple.git
   cd spacetimeripple
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Open your browser and navigate to the given URL

## How It Works

The animation combines two main effects:

1. **Base Wave Animation**: Uses Perlin noise to generate natural-looking wave patterns across a grid system. This creates a constant, organic movement.

2. **Interactive Ripples**: When users click and drag across the screen, the application generates circular wave patterns that emanate from the drag path, interacting with the base animation.

The entire visualization is implemented using WGSL (WebGPU Shading Language) for optimal performance and smooth animations.

## Technical Details

- Built with vanilla JavaScript and WebGPU
- Uses WGSL for shader implementation
- Implements Perlin noise for natural wave generation
- Utilizes compute shaders for ripple physics calculations

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- WebGPU for providing the next-generation graphics API
- Ken Perlin for creating Perlin noise