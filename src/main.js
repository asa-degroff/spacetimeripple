// Initialize WebGPU
async function initWebGPU() {
    if (!navigator.gpu) {
        throw new Error('WebGPU not supported');
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error('No adapter found');
    }

    const device = await adapter.requestDevice();
    const canvas = document.getElementById('gpu-canvas');
    const context = canvas.getContext('webgpu');

    // Function to calculate and set optimal canvas size
    function updateCanvasSize() {
        const targetAspectRatio = 4 / 3;
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const windowAspectRatio = windowWidth / windowHeight;

        let width, height;
        if (windowAspectRatio > targetAspectRatio) {
            // Window is wider than target ratio, fit to height
            height = windowHeight;
            width = height * targetAspectRatio;
        } else {
            // Window is taller than target ratio, fit to width
            width = windowWidth;
            height = width / targetAspectRatio;
        }

        // Set the display size
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';

        // Set the actual canvas size accounting for device pixel ratio
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);

        // Update the viewport and scissor to match the new size
        context.configure({
            device,
            format: navigator.gpu.getPreferredCanvasFormat(),
            alphaMode: 'premultiplied',
        });
    }

    // Initial size update
    updateCanvasSize();

    // Add resize listener
    window.addEventListener('resize', updateCanvasSize);

    const format = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
        device,
        format,
        alphaMode: 'premultiplied',
    });

    return { device, context, format, canvas };
}

// Load shader code
async function loadShaders() {
    const gridShader = await fetch('/src/shaders/wavy-grid.wgsl').then(res => res.text());
    return { gridShader };
}

// Ripple management class
class RippleManager {
    constructor(maxRipples = 64) {
        this.maxRipples = maxRipples;
        this.ripples = [];
        this.lastRippleTime = 0;
        this.minRippleInterval = 50; // ms between ripples
        this.maxAge = 2.0; // seconds
    }

    addRipple(x, y, timestamp) {
        if (timestamp - this.lastRippleTime < this.minRippleInterval) {
            return;
        }

        this.ripples.push({
            x,
            y,
            startTime: timestamp / 1000.0, // Convert to seconds
            strength: 1.0
        });

        if (this.ripples.length > this.maxRipples) {
            this.ripples.shift();
        }

        this.lastRippleTime = timestamp;
    }

    update(timestamp) {
        const currentTime = timestamp / 1000.0; // Convert to seconds
        
        this.ripples = this.ripples.filter(ripple => {
            const age = currentTime - ripple.startTime;
            ripple.strength = 1.0 - (age / this.maxAge);
            return age < this.maxAge;
        });

        // Return array for GPU: [x, y, strength, startTime] for each ripple
        const rippleData = new Float32Array(this.maxRipples * 4);
        this.ripples.forEach((ripple, i) => {
            const baseIndex = i * 4;
            rippleData[baseIndex] = ripple.x;
            rippleData[baseIndex + 1] = ripple.y;
            rippleData[baseIndex + 2] = ripple.strength;
            rippleData[baseIndex + 3] = ripple.startTime; // Send actual start time in seconds
        });

        return rippleData;
    }
}

async function createPipeline(device, format, shaderCode) {
    const shaderModule = device.createShaderModule({
        code: shaderCode,
    });

    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' }
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' }
            }
        ],
    });

    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
    });

    return device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'vertexMain',
            buffers: [{
                arrayStride: 8,
                attributes: [{
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x2',
                }],
            }],
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fragmentMain',
            targets: [{
                format: format,
            }],
        },
        primitive: {
            topology: 'triangle-strip',
            stripIndexFormat: 'uint32',
        },
    });
}

async function init() {
    const { device, context, format, canvas } = await initWebGPU();
    const { gridShader } = await loadShaders();

    // Create vertex buffer with a full-screen quad
    const vertices = new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        1, 1,
    ]);

    const vertexBuffer = device.createBuffer({
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    device.queue.writeBuffer(vertexBuffer, 0, vertices);

    // Create uniform buffers
    const timeUniformBuffer = device.createBuffer({
        size: 32, // Increased to 32 bytes (time: f32, aspect ratio: f32, padding: f32)
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const rippleUniformBuffer = device.createBuffer({
        size: 1024, // 64 ripples * 16 bytes each (vec2f + 2 * f32)
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group
    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' }
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' }
            }
        ],
    });

    const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: { buffer: timeUniformBuffer },
            },
            {
                binding: 1,
                resource: { buffer: rippleUniformBuffer },
            }
        ],
    });

    // Create pipelines
    const gridPipeline = await createPipeline(device, format, gridShader);

    // Initialize ripple manager
    const rippleManager = new RippleManager();

    // Add interaction handlers
    let isMouseDown = false;
    canvas.addEventListener('mousedown', (e) => {
        isMouseDown = true;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = 1.0 - (e.clientY - rect.top) / rect.height;
        rippleManager.addRipple(x, y, performance.now());
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!isMouseDown) return;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = 1.0 - (e.clientY - rect.top) / rect.height;
        rippleManager.addRipple(x, y, performance.now());
    });

    canvas.addEventListener('mouseup', () => {
        isMouseDown = false;
    });

    canvas.addEventListener('mouseleave', () => {
        isMouseDown = false;
    });

    // Animation loop
    function frame(timestamp) {
        const timeUniforms = new Float32Array([
            timestamp / 1000, // time
            canvas.width / canvas.height, // aspect ratio
            0, // padding for alignment
            0, // padding for alignment
        ]);
        device.queue.writeBuffer(timeUniformBuffer, 0, timeUniforms);

        // Update and write ripple data
        const rippleData = rippleManager.update(timestamp);
        device.queue.writeBuffer(rippleUniformBuffer, 0, rippleData);

        const commandEncoder = device.createCommandEncoder();
        const passEncoder = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setPipeline(gridPipeline);
        passEncoder.draw(4);
        passEncoder.end();

        device.queue.submit([commandEncoder.finish()]);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

init().catch(console.error);
