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

    return { device, context, format, canvas };
}

// Load shader code
async function loadShaders() {
    const gridShader = await fetch('/src/shaders/wavy-grid.wgsl').then(res => res.text());
    return { gridShader };
}

// Ripple management class
class RippleManager {
    constructor(maxRipples = 128) {
        this.maxRipples = maxRipples;
        
        // Pre-allocate ripples array with fixed size objects
        // This avoids memory allocations during animation
        this.ripples = new Array(maxRipples);
        for (let i = 0; i < maxRipples; i++) {
            this.ripples[i] = {
                x: 0,
                y: 0,
                startTime: 0,
                strength: 0,
                active: false
            };
        }
        
        // Track indices for efficient array management
        this.nextRippleIndex = 0;
        this.lastRippleTime = 0;
        this.minRippleInterval = 25; // ms between ripples
        this.maxAge = 2.0; // seconds
        this.activeRippleCount = 0;
        
        // Pre-allocate ripple data array to avoid allocation in update
        this.rippleData = new Float32Array(this.maxRipples * 4);
    }

    addRipple(x, y, timestamp) {
        if (timestamp - this.lastRippleTime < this.minRippleInterval) {
            return;
        }

        // Reuse existing ripple object instead of creating new one
        const ripple = this.ripples[this.nextRippleIndex];
        ripple.x = x;
        ripple.y = y;
        ripple.startTime = timestamp / 1000.0; // Convert to seconds
        ripple.strength = 1.0;
        ripple.active = true;
        
        // Update index for next ripple (circular buffer pattern)
        this.nextRippleIndex = (this.nextRippleIndex + 1) % this.maxRipples;
        this.lastRippleTime = timestamp;
    }

    update(timestamp) {
        const currentTime = timestamp / 1000.0; // Convert to seconds
        this.activeRippleCount = 0;
        
        // First pass: update strengths and count active ripples
        const STRENGTH_THRESHOLD = 0.01;
        for (let i = 0; i < this.maxRipples; i++) {
            const ripple = this.ripples[i];
            if (!ripple.active) continue;
            
            const age = currentTime - ripple.startTime;
            if (age >= this.maxAge) {
                // Deactivate expired ripples
                ripple.active = false;
                ripple.strength = 0;
                continue;
            }
            
            // Update strength
            ripple.strength = 1.0 - (age / this.maxAge);
            
            // Count active ripples above threshold
            if (ripple.strength > STRENGTH_THRESHOLD) {
                // Place active ripples at the beginning of the data array
                const baseIndex = this.activeRippleCount * 4;
                this.rippleData[baseIndex] = ripple.x;
                this.rippleData[baseIndex + 1] = ripple.y;
                this.rippleData[baseIndex + 2] = ripple.strength;
                this.rippleData[baseIndex + 3] = ripple.startTime;
                this.activeRippleCount++;
            } else {
                // Deactivate weak ripples
                ripple.active = false;
            }
        }
        
        // Clear remaining slots in ripple data
        for (let i = this.activeRippleCount; i < this.maxRipples; i++) {
            const baseIndex = i * 4;
            this.rippleData[baseIndex + 2] = 0; // Only need to zero out strength
        }

        return {
            data: this.rippleData,
            activeCount: this.activeRippleCount
        };
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
        size: 48, // Increased to 48 bytes (time: f32, aspect ratio: f32, activeRippleCount: f32, padding: f32)
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const rippleUniformBuffer = device.createBuffer({
        size: 2048, // 128 ripples * 16 bytes each (vec2f + 2 * f32)
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

    // Get cursor dot element for visual feedback
    const cursorDot = document.getElementById('cursor-dot');

    // Optimize mouse input handling
    let isMouseDown = false;
    let lastMouseX = 0, lastMouseY = 0;
    let lastClientX = 0, lastClientY = 0;
    let canvasRect = canvas.getBoundingClientRect();
    
    // Update canvas rect on resize
    const updateCanvasRect = () => {
        canvasRect = canvas.getBoundingClientRect();
    };
    
    // Add resize observer for more reliable size updates
    const resizeObserver = new ResizeObserver(updateCanvasRect);
    resizeObserver.observe(canvas);
    window.addEventListener('resize', updateCanvasRect);
    
    // Convert mouse/pointer position to normalized coordinates
    const getNormalizedCoordinates = (clientX, clientY) => {
        return {
            x: (clientX - canvasRect.left) / canvasRect.width,
            y: 1.0 - (clientY - canvasRect.top) / canvasRect.height
        };
    };
    
    // Update cursor dot position
    const updateCursorDot = (clientX, clientY, visible) => {
        cursorDot.style.left = `${clientX}px`;
        cursorDot.style.top = `${clientY}px`;
        cursorDot.style.opacity = visible ? '1' : '0';
    };

    // Use pointer events for better performance across devices
    canvas.addEventListener('pointerdown', (e) => {
        isMouseDown = true;
        const coords = getNormalizedCoordinates(e.clientX, e.clientY);
        lastMouseX = coords.x;
        lastMouseY = coords.y;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        // Show the cursor dot
        updateCursorDot(e.clientX, e.clientY, true);
        // Still add a ripple immediately on pointer down for responsiveness
        rippleManager.addRipple(coords.x, coords.y, performance.now());
    }, { passive: true });

    canvas.addEventListener('pointermove', (e) => {
        if (!isMouseDown) return;
        const coords = getNormalizedCoordinates(e.clientX, e.clientY);
        lastMouseX = coords.x;
        lastMouseY = coords.y;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        // Update cursor dot position
        updateCursorDot(e.clientX, e.clientY, true);
        // Store position but don't add ripple here - will be added in animation frame
    }, { passive: true });

    canvas.addEventListener('pointerup', () => {
        isMouseDown = false;
        // Hide the cursor dot
        updateCursorDot(lastClientX, lastClientY, false);
    }, { passive: true });

    canvas.addEventListener('pointerleave', () => {
        isMouseDown = false;
        // Hide the cursor dot
        updateCursorDot(lastClientX, lastClientY, false);
    }, { passive: true });

    // Animation loop
    function frame(timestamp) {
        // Add ripple at current mouse position if mouse is down
        // This synchronizes ripple creation with the render loop
        if (isMouseDown) {
            rippleManager.addRipple(lastMouseX, lastMouseY, timestamp);
        }
        
        // Update and write ripple data
        const rippleResult = rippleManager.update(timestamp);
        device.queue.writeBuffer(rippleUniformBuffer, 0, rippleResult.data);
        
        const timeUniforms = new Float32Array([
            timestamp / 1000, // time
            canvas.width / canvas.height, // aspect ratio
            rippleResult.activeCount, // number of active ripples
            0, // padding for alignment
        ]);
        device.queue.writeBuffer(timeUniformBuffer, 0, timeUniforms);

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
