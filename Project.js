import {defs, tiny} from './examples/common.js';
import {Color_Phong_Shader, Shadow_Textured_Phong_Shader,
    Depth_Texture_Shader_2D, Buffered_Texture, LIGHT_DEPTH_TEX_SIZE} from './examples/shadow-demo-shaders.js'
import { Shape_From_File } from "./examples/obj-file-demo.js"

const {
    Vector, Vector3, vec, vec3, vec4, color, hex_color, Shader, Matrix, Mat4, Light, Shape, Material, Scene, Texture,
} = tiny;

const {Cube, Axis_Arrows, Textured_Phong, Subdivision_Sphere, Phong_Shader, Cone_Tip, Square} = defs

const white = new Material(new defs.Basic_Shader())

// Mouse movements
let dx = 0;
let dy = 0;

// Mouse sensitivity
const sensitivity = 5;

let origin = vec3(0, 0, 0); // Location of camera matrix (aka the player)
let camera_matrix = Mat4.look_at(vec3(0, 0, 0), vec3(0, 0, -1), vec3(0, 1, 0)); // Camera matrix in terms of only rotations - handle translations separately
let front = vec3(0, 0, 1); // Vector facing the direction that the player can walk in (w or s movements)
let right = vec3(1, 0, 0); // Vector facing the right of the direction that the player can walk in (d or a movements)
let pitch = 0; // Variables representing camera angle (left and right)
let yaw = 0; // Up and down
const TERRAIN_BOUNDS = vec3(100, 0, 100);
// Colors for balloons at various positions of health (by their index)
const BALLOON_HEALTH = [hex_color("FF0000"), hex_color("FF0000"), hex_color("0000FF"), hex_color("00FF00")]
const INITIAL_POSITION = vec3(0, 0, 8) 
let player; // Create player object on scene initialization to deal with collisions

// Overriding original movement and mouse controller to create fps controller
const Movement = 
class Movement extends defs.Movement_Controls {
    add_mouse_controls (canvas) {
        this.mouse = { "from_center": vec( 0,0 ) };
        const mouse_position = (e, rect = canvas.getBoundingClientRect()) =>
        vec( e.clientX - (rect.left + rect.right)/2, e.clientY - (rect.bottom + rect.top)/2 );
        document.addEventListener( "mouseup",   e => { this.mouse.anchor = undefined; } );
        canvas.addEventListener( "mousedown", e => { e.preventDefault(); this.mouse.anchor = mouse_position(e); } );
        canvas.addEventListener( "mousemove", e => { e.preventDefault(); this.mouse.from_center = mouse_position(e); } );
        canvas.addEventListener( "mouseout",  e => { if( !this.mouse.anchor ) this.mouse.from_center.scale_by(0) } );

        canvas.onclick = () => canvas.requestPointerLock();
        
        let updatePosition = (e) => {
            dx = e.movementX;
            dy = e.movementY;
          };

        let lockChangeAlert = () => {
            if (document.pointerLockElement === canvas) {
              document.addEventListener("mousemove", updatePosition, false);
            } else {
              document.removeEventListener("mousemove", updatePosition, false);
              dx = dy = 0;
            }
          };
      
          document.addEventListener('pointerlockchange', lockChangeAlert, false);
    }

    first_person_flyaround (radians_per_frame, meters_per_frame, leeway = 70) {
        // thrust contains the keyboard WASD input controls
        if (this.thrust[2] !== 0 || this.thrust[0] !== 0)
        {
            let newOrigin;
            if (this.thrust[2] !== 0) { // Forward/Backward movement (W and S)
                newOrigin = origin.plus(front.times(meters_per_frame * this.thrust[2] * -1));
            }
            if (this.thrust[0] !== 0) { // Left and right movement (A and D)
                newOrigin = origin.plus(right.times(meters_per_frame * this.thrust[0] * - 1))
            }
            // Checking if player is going out of bounds 
            newOrigin[0] = Math.max(-TERRAIN_BOUNDS[0], Math.min(newOrigin[0], TERRAIN_BOUNDS[0]))
            newOrigin[2] = Math.max(-TERRAIN_BOUNDS[2], Math.min(newOrigin[2], TERRAIN_BOUNDS[2]))

            // Check if player collides with anything, if they don't, then update their position but otherwise keep it the same
            if (player.canMove(Mat4.translation(...newOrigin)))
                origin = newOrigin;
        }
    }

    // Overriding mouse controls here to allow for first person movement
    third_person_arcball (radians_per_frame) {
        pitch = pitch + sensitivity * dx * radians_per_frame;
        // Limit how much the player can look up, as in traditional fps games
        yaw = Math.max(- Math.PI / 2, Math.min(yaw + sensitivity * dy * radians_per_frame, Math.PI / 2))
        camera_matrix = Mat4.identity();
        camera_matrix = camera_matrix.times(Mat4.rotation(-pitch, 0, 1, 0)); // Rotate by pitch
        camera_matrix = camera_matrix.times(Mat4.rotation(-yaw, 1, 0, 0)); // Rotate by yaw
        // Recalculate front and right vectors every time player changes where they look so they move accordingly
        front = Mat4.rotation(-pitch, 0, 1, 0).times(vec3(0, 0, 1))
        front = vec3(front[0], front[1], front[2])
        right = vec3(0, 1, 0).cross(front)
    }

    display (context, graphics_state, dt= graphics_state.animation_delta_time / 1000) {
        console.time("Movement display")
        const m  = this.speed_multiplier * this.meters_per_frame,
              r  = this.speed_multiplier * this.radians_per_frame

        if (this.will_take_over_uniforms) {
            this.reset ();
            this.will_take_over_uniforms = false;
        }

        if (!this.mouse_enabled_canvases.has(context.canvas))
        {
            this.add_mouse_controls(context.canvas);
            this.mouse_enabled_canvases.add(context.canvas);
        }

        this.first_person_flyaround (dt * r, dt * m);
        if (!this.mouse.anchor)
            this.third_person_arcball(dt * r);
        console.timeEnd("Movement display")
    }
}

// Objects that have a collision box should extend this class
// Matrix is the Mat4 matrix that represents the object's position, scaling, rotation, etc.
// Size is the size of the bounding box of the object, represented as a Mat4 scale only (do not rotate or translate the size matrix)
// For any object that is intended to have collision, the size matrix passed in should be adjusted
// to appropriately bound the object itself
class Collidable {
    constructor(matrix, size) {
        this.collidedObjects = new Set(); // Keeps track of all other objects that have collided with this object
        this.matrix = matrix;
        this.size = size; // Size is a scale matrix; if the bound is a box then this represents the dimensions of the box otherwise if the bound is a sphere
        // it represents the radius
        this.boundingBox = true; // Determines whether the bound type being used is a bounding box or a bounding sphere
        this.updateBoundBox();
    }

    // Use this function whenever the matrix is updated since it is necessary to retranslate the bounding box
    updateMatrix(newMatrix) {
        this.matrix = newMatrix;
        this.updateBoundBox();
    }

    updateBoundBox() {
        this.min_x = this.matrix[0][3] - this.size[0][0];
        this.max_x = this.matrix[0][3] + this.size[0][0];
        this.min_y = this.matrix[1][3] - this.size[1][1];
        this.max_y = this.matrix[1][3] + this.size[1][1];
        this.min_z = this.matrix[2][3] - this.size[2][2];
        this.max_z = this.matrix[2][3] + this.size[2][2];
    }

    checkCollision(other) {
        console.time("Collision checking")

        let test;
        if (this.boundingBox && other.boundingBox) // Box-Box collision
        {
            test = (
                this.min_x <= other.max_x &&
                this.max_x >= other.min_x &&
                this.min_y <= other.max_y &&
                this.max_y >= other.min_y &&
                this.min_z <= other.max_z && 
                this.max_z >= other.min_z
            );
        }
        else if (!this.boundingBox && !other.boundingBox) // Sphere-Sphere collision
        {
            const distance = Math.sqrt(
                (this.matrix[0][3] - other.matrix[0][3]) * (this.matrix[0][3] - other.matrix[0][3]) +
                (this.matrix[1][3] - other.matrix[1][3]) * (this.matrix[1][3] - other.matrix[1][3]) +
                (this.matrix[2][3] - other.matrix[2][3]) * (this.matrix[2][3] - other.matrix[2][3]));
            test = distance < sphere.size[0][0] + other.size[0][0];
        }
        else if ((this.boundingBox && !other.boundingBox) || (!this.boundingBox && other.boundingBox)) // Sphere-Box collision
        {
            const box = this.boundingBox ? this : other;
            const sphere = !this.boundingBox ? this : other;
            // get box closest point to sphere center by clamping
            const x = Math.max(box.min_x, Math.min(sphere.matrix[0][3], box.max_x));
            const y = Math.max(box.min_y, Math.min(sphere.matrix[1][3], box.max_y));
            const z = Math.max(box.min_z, Math.min(sphere.matrix[2][3], box.max_z));

            // this is the same as isPointInsideSphere
            const distance = Math.sqrt(
                (x - sphere.matrix[0][3]) * (x - sphere.matrix[0][3]) +
                (y - sphere.matrix[1][3]) * (y - sphere.matrix[1][3]) +
                (z - sphere.matrix[2][3]) * (z - sphere.matrix[2][3]));

            test = distance < sphere.size[0][0];
        }
        // Add the collided object to the list of collided objects (and this object to the other object's list of collided objects)
        if (test) {
            if (!this.collidedObjects.has(other)) {
                this.collidedObjects.add(other);
                other.collidedObjects.add(this);
            }
        }

        console.timeEnd("Collision checking")

        return test;
    }
}

// Player should only collide with nature objects (its fine if they pass through balloons)
class Player extends Collidable {
    constructor(matrix, collidables) {
        super(matrix, Mat4.scale(1, 1, 1))
        this.collidables = collidables; 
    }
    canMove(newPosition) {
        const oldPosition = this.matrix;
        this.updateMatrix(newPosition) // Update the matrix with the new position to check if the player can move
        let collided = false;
        this.collidables.forEach((collidable) => {
            if (this.checkCollision(collidable)) {
                collided = true;
            }
        })
        if (collided) // If there was a collision, revert the player's position matrix to the previous
            this.updateMatrix(oldPosition);
        return !collided;
    }
}

class Projectile extends Collidable {
    constructor(matrix, size, velocity, pitch, yaw, shape, material, shadow) {
        super(matrix, size);
        this.velocity = velocity;
        this.pitch = pitch;
        this.yaw = yaw;
        this.out_of_bounds = false;
        this.shape = shape;
        this.material = material;
        this.shadow = shadow;
    }

    // There is no need to pass in collidables for projectiles because the other objects it should collide with can just check for 
    // collision with the projectile (instead of having every projectile check for collision with every balloon, we can just have every
    // balloon check for collision with every projectile)
    draw(context, program_state, dt, shadow_pass) {
        const posChange = this.velocity.times(dt * -1 * 0.75);
        this.updateMatrix(this.matrix.times(Mat4.translation(...posChange)))
        if (this.matrix[1][3] + this.size[1][1] <= TERRAIN_BOUNDS[1])
            this.out_of_bounds = true;

        // No need to check collisions with the projectiles and the balloons because it is already checked by the balloons
        this.shape.draw(context, program_state, this.matrix.times(Mat4.rotation(-1 * this.pitch, 0, 1, 0)).times(Mat4.rotation(-1 * this.yaw, 1, 0, 0)).times(this.size), shadow_pass ? this.material : this.shadow)
        this.velocity[1] = this.velocity[1] + (9.8 * dt * 0.75)
    }
}

class Balloon extends Collidable {
    constructor(size, initial_pos, durability, shape, material, shadow) 
    {
        super(Mat4.identity(), size);
        this.durability = durability;
        this.initial_pos = initial_pos;
        this.boundingBox = false; // Sphere bound
        this.shape = shape;
        this.material = material;
        this.shadow = shadow;

        // Balloons will follow a fixed path, and how exactly it moves on this path will be based on this progress range
        this.progress = 0;
    }

    draw(context, program_state, dt, collidables, shadow_pass) 
    {
        this.progress += dt * 0.5;

        // Stages represent its stages of motion - i.e. parabolic, sinusoidal, circular, etc.
        const stage1Time = Math.min(5, this.progress) // 0 <= t <= 5
        let matrix = Mat4.translation(stage1Time, stage1Time * stage1Time * 10 / 25, 0).times(this.initial_pos)
        if (this.progress >= 5) // 5 <= t <= 10
        {
            const stage2Time = Math.min(10 - 5, this.progress - 5)
            matrix = Mat4.translation(2.5 * stage2Time, 0, 0).times(matrix)
        }
        if (this.progress >= 10) // 10 <= t <= 41.4
        {
            const stage3Time = Math.min(41.4 - 10, this.progress - 10)
            matrix = Mat4.translation(2.5 * stage3Time, 0, 2.5 * Math.sin(stage3Time)).times(matrix)
        }
        if (this.progress >= 41.4) // 41. 4 <= t <= 60
        {
            const stage4Time = Math.min(60 - 41.4, this.progress - 41.4) * (Math.PI * 3 / 2 / (60 - 41.4))
            matrix = Mat4.translation(matrix[0][3] + 25, matrix[1][3], matrix[2][3]).times(Mat4.rotation(-stage4Time, 0, 1, 0)).times(Mat4.translation(-(matrix[0][3] + 25), -matrix[1][3], -matrix[2][3])).times(matrix)
        }
        if (this.progress >= 60) // 60 <= t <= 80
        {
            const stage5Time = Math.min(80 - 60, this.progress - 60) * (Math.PI / (80 - 60))
            matrix = Mat4.translation(matrix[0][3], matrix[1][3], matrix[2][3] + 25).times(Mat4.rotation(stage5Time, 0, 1, 0)).times(Mat4.translation(-matrix[0][3], -matrix[1][3], -(matrix[2][3] + 25))).times(matrix)
        }
        if (this.progress >= 80) // 80 <= t <= 85
        {
            const stage6Time = Math.min(85 - 80, this.progress - 80)
            matrix = Mat4.translation(0, 0, stage6Time * 2).times(matrix)
        }
        if (this.progress >= 85) // 85 <= t <= 130
        {
            const stage7Time = Math.min(130 - 85, this.progress - 85)
            matrix = Mat4.translation(-stage7Time * 2, 0, Math.sin(stage7Time)).times(matrix)
        }
        if (this.progress >= 130) // 130 <= t <= 135
        {
            const stage8Time = Math.min(135 - 130, this.progress - 130)
            matrix = Mat4.translation(0, 0, stage8Time * 2).times(matrix)
        }
        if (this.progress >= 135) // 135 <= t <= 215
        {
            const stage9Time = Math.min(215 - 135, this.progress - 135)
            matrix = Mat4.translation(stage9Time * 2, 0, Math.sin(stage9Time)).times(matrix)
        }
        if (this.progress >= 215) // 215 <= t <= 309.25
        {
            const stage10Time = Math.min(309.25 - 215, this.progress - 215)
            matrix = Mat4.translation(0, 2 * Math.sin(stage10Time), -2 * stage10Time).times(matrix)
        }
        if (this.progress >= 309.25) // 309.25 <= t <= 314.25
        {
            const stage11Time = Math.min(314.25 - 309.25, this.progress - 309.25)
            matrix = Mat4.translation(stage11Time, -stage11Time * stage11Time * 10 / 25, 0).times(matrix)
        }

        this.updateMatrix(matrix)
        
        // Check for collision with any projectiles
        let collided = false;
        collidables.forEach((collidable) => {
            if (this.checkCollision(collidable)) {
                collided = true;
            }
        })
        this.shape.draw(context, program_state, this.matrix.times(this.size), shadow_pass ? this.material.override(BALLOON_HEALTH[this.durability - this.collidedObjects.size]) : this.shadow)
    }
}

class Nature extends Collidable {
    constructor(matrix, size, shape, material, shadow, boundOffset = Mat4.identity())
    {
        super(matrix, size);
        this.shape = shape;
        this.material = material;
        this.shadow = shadow;
        this.boundOffset = boundOffset;
        this.updateBoundBox()
    }

    updateBoundBox() {
        if (this.boundOffset)
        {
            this.min_x = this.matrix[0][3] - this.size[0][0] - (this.boundOffset[0][3] * this.size[0][0]);
            this.max_x = this.matrix[0][3] + this.size[0][0] - (this.boundOffset[0][3] * this.size[0][0]);
            this.min_y = this.matrix[1][3] - this.size[1][1] - (this.boundOffset[1][3] * this.size[1][1]);
            this.max_y = this.matrix[1][3] + this.size[1][1] - (this.boundOffset[1][3] * this.size[1][1]);
            this.min_z = this.matrix[2][3] - this.size[2][2] - (this.boundOffset[2][3] * this.size[2][2]);
            this.max_z = this.matrix[2][3] + this.size[2][2] - (this.boundOffset[2][3] * this.size[2][2]);
        }
    }


    // Check for collision with projectiles
    draw(context, program_state, collidables, shadow_pass, boundBox = null, boundBoxMaterial = null)
    {
        if (boundBox !== null)
        {
            boundBox.draw(context, program_state, Mat4.translation((this.min_x + this.max_x) / 2, (this.min_y + this.max_y) / 2, (this.min_z + this.max_z) / 2).times(this.size), white, "LINES")
        }
        // Check the collision to update the collided object index for darts
        collidables.forEach((collidable) => {
            this.checkCollision(collidable);
        });
        this.shape.draw(context, program_state, this.matrix, shadow_pass ? this.material : this.shadow)
    }
}

function drawTerrain(context, program_state, shape, material) {
    console.time("Draws terrain")
    // Have the terrain by a large cube with its top face being stood on
    shape.draw(context, program_state, Mat4.translation(0, -2, 0).times(Mat4.scale(100, 1, 100)), material);
    console.timeEnd("Draws terrain")
}

function drawSkybox(context, program_state, shape, materials, shadow_pass) {
    console.time("Draws skybox")
    if (shadow_pass)
    {
        shape.draw(context, program_state, Mat4.translation(0, 100, 0).times(Mat4.scale(100, 1, 100)).times(Mat4.rotation(Math.PI / 2, 1, 0 ,0)), materials[0])
        shape.draw(context, program_state, Mat4.translation(0, 0, -100).times(Mat4.scale(100, 100, 1)), materials[1])
        shape.draw(context, program_state, Mat4.translation(-100, 0, 0).times(Mat4.rotation(Math.PI / 2, 0, 1, 0)).times(Mat4.scale(100, 100, 1)), materials[2])
        shape.draw(context, program_state, Mat4.translation(100, 0, 0).times(Mat4.rotation(-Math.PI / 2, 0, 1, 0)).times(Mat4.scale(100, 100, 1)), materials[3])
        shape.draw(context, program_state, Mat4.translation(0, 0, 100).times(Mat4.scale(100, 100, 1)).times(Mat4.rotation(Math.PI, 0, 1, 0)), materials[4])
    }
    console.timeEnd("Draws skybox")
}


// Debugging
class Cube_Outline extends Shape {
    constructor() {
        super("position", "color");
        //  TODO (Requirement 5).
        // When a set of lines is used in graphics, you should think of the list entries as
        // broken down into pairs; each pair of vertices will be drawn as a line segment.
        // Note: since the outline is rendered with Basic_shader, you need to redefine the position and color of each vertex
        const white = color(1, 1, 1, 1);
        this.arrays.position = Vector3.cast(
            [1, -1, 1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [-1, -1, 1], [-1, -1, -1], [-1, -1, -1], [1, -1, -1], // bottom vertices 
            [1, 1, 1], [1, 1, -1], [1, 1, 1], [-1, 1, 1], [-1, 1, 1], [-1, 1, -1], [-1, 1, -1], [1, 1, -1], // top vertices
            [1, -1, 1], [1, 1, 1], [1, -1, -1], [1, 1, -1], [-1, -1, 1], [-1, 1, 1], [-1, -1, -1], [-1, 1, -1] // bottom-top connection vertices
        );
        for (let i = 0; i < this.arrays.position.length; i++) {
            this.arrays.color.push(white);
        }
        this.indices = false;
    }
}

export class Project extends Scene {
    constructor() {
        super();
        this.shapes = {
            projectile: new defs.Cone_Tip(5, 5),
            sphere: new Subdivision_Sphere(4),
            bounding_box: new Cube_Outline(),
            ground: new Cube(),
            square: new Square(),
            tree: new Shape_From_File("assets/CommonTree_1.obj"),
            tree2: new Shape_From_File("assets/CommonTree_2.obj"),
            tree3: new Shape_From_File("assets/CommonTree_3.obj"),
            tree4: new Shape_From_File("assets/CommonTree_4.obj"),
            tree5: new Shape_From_File("assets/CommonTree_5.obj"),
            willow: new Shape_From_File("assets/Willow_5.obj"),
            birch: new Shape_From_File("assets/BirchTree_2.obj"),
            rock: new Shape_From_File("assets/Rock_3.obj"),
            log: new Shape_From_File("assets/WoodLog.obj"),
        }

        this.materials = {
            phong: new Material(new Phong_Shader(), {
                color: hex_color("#0000FF"), ambient: 0.5, specularity: 1.0
            }),
            bound_box: new Material(new Phong_Shader(), {
                color: hex_color("#FFFFFF", 0.1), ambient: 1.0, diffusivity: 1.0,
            }),
            terrain: new Material(new Shadow_Textured_Phong_Shader(1), {
                color: hex_color("#009a17"), ambient: .3, diffusivity: 0.6, specularity: 0, smoothness: 64,
                color_texture: null,
                light_depth_texture: null
            }),
            pure: new Material(new Color_Phong_Shader(), {
                color: hex_color("#0000FF"), ambient: 1.0, diffusivity: 1.0,
            }),
            shadow: new Material(new Shadow_Textured_Phong_Shader(1), {
                color: color(1, 1, 1, 1), ambient: .3, diffusivity: 0.6, specularity: 0.4, smoothness: 64,
            }), 
            light_src: new Material(new Phong_Shader(), {
                color: color(1, 1, 1, 1), ambient: 1, diffusivity: 0, specularity: 0
            }),
            terrain_pure: new Material(new Phong_Shader(), {
                color: hex_color("#009a17"),
                specularity: 0
            }),
            skybox_top: new Material(new Textured_Phong(), {
                color: hex_color("#000000"),
                ambient: 1, diffusivity: 0.1, specularity: 0.1,
                texture: new Texture("assets/Skybox_Top.png", "NEAREST")
            }), 
            skybox_front: new Material(new Textured_Phong(), {
                color: hex_color("#000000"),
                ambient: 1, diffusivity: 0.1, specularity: 0.1,
                texture: new Texture("assets/Skybox_Center.png", "NEAREST")
            }),
            skybox_right: new Material(new Textured_Phong(), {
                color: hex_color("#000000"),
                ambient: 1, diffusivity: 0.1, specularity: 0.1,
                texture: new Texture("assets/Skybox_Right.png", "NEAREST")
            }),
            skybox_left: new Material(new Textured_Phong(), {
                color: hex_color("#000000"),
                ambient: 1, diffusivity: 0.1, specularity: 0.1,
                texture: new Texture("assets/Skybox_Left.png", "NEAREST")
            }),
            skybox_back: new Material(new Textured_Phong(), {
                color: hex_color("#000000"),
                ambient: 1, diffusivity: 0.1, specularity: 0.1,
                texture: new Texture("assets/Skybox_Back.png", "NEAREST")
            }),
            tree: new Material(new Tree_Shader(), {
                leaf: hex_color("#77a37a"),
                stump: hex_color("#53350A"), 
                ycutoff: 0.1
            }),
            tree2: new Material(new Tree_Shader(), {
                leaf: hex_color("#5f926a"),
                stump: hex_color("#53350A"), 
                ycutoff: -0.2
            }),
            tree3: new Material(new Tree_Shader(), {
                leaf: hex_color("#587e60"),
                stump: hex_color("#53350A"), 
                ycutoff: -0.6
            }),
            tree4: new Material(new Tree_Shader(), {
                leaf: hex_color("#485e52"),
                stump: hex_color("#53350A"), 
                ycutoff: -0.3
            }),
            tree5: new Material(new Tree_Shader(), {
                leaf: hex_color("#3a4f3f"),
                stump: hex_color("#53350A"), 
                ycutoff: 0.1
            }),
            willow: new Material(new Tree_Shader(), {
                leaf: hex_color("#3A5F0B"),
                stump: hex_color("#53350A"), 
                ycutoff: -0.6
            }),
            birch: new Material(new Tree_Shader(), {
                leaf: hex_color("#3A5F0B"),
                stump: hex_color("#53350A"), 
                ambient: 0.2,
                ycutoff: -0.6
            }),
            rock: new Material(new Phong_Shader(), {
                color: hex_color("#e3e5e2"),
                ambient: 0.2
            }),
            rock2: new Material(new Phong_Shader(), {
                color: hex_color("#929292"),
                ambient: 0.2,
            }),
            log: new Material(new Phong_Shader(), {
                color: hex_color("635946")
            })


        }

        this.projectiles = [];
        this.balloons = []
        this.nature = [
            new Nature(Mat4.translation(25, 8, -60).times(Mat4.scale(4, 4, 4)), Mat4.scale(1, 4, 1), this.shapes.tree, this.materials.tree, this.materials.shadow, Mat4.translation(0, 1.2, 1)), 
            new Nature(Mat4.translation(10, 14, -75).times(Mat4.scale(6.5, 7, 5)).times(Mat4.rotation(Math.PI / 2, 0, 1, 0)), Mat4.scale(1, 3.8, 1), this.shapes.tree, this.materials.tree, this.materials.shadow, Mat4.translation(1.5, 2.95, 0)), 
            new Nature(Mat4.translation(0, 8, -45).times(Mat4.scale(5, 5, 5)).times(Mat4.rotation(Math.PI / 4, 0, 1, 0)), Mat4.scale(1, 4.7, 1), this.shapes.willow, this.materials.willow, this.materials.shadow, Mat4.translation(1.5, 0.9, 0.8)),
            new Nature(Mat4.translation(25, 10, 0).times(Mat4.scale(5, 5, 5)).times(Mat4.rotation(Math.PI / 4, 0, 1, 0)), Mat4.scale(1, 5.5, 1), this.shapes.birch, this.materials.birch, this.materials.shadow, Mat4.translation(1.7, 1, 2)),
            new Nature(Mat4.translation(-20, 12, -70).times(Mat4.scale(5, 5, 5)).times(Mat4.rotation(Math.PI, 0, 1, 0)), Mat4.scale(1, 7, 1), this.shapes.tree2, this.materials.tree2, this.materials.shadow, Mat4.translation(0.5, 0.85, -3)),
            new Nature(Mat4.translation(-20, 13, -40).times(Mat4.scale(5, 5, 5)).times(Mat4.rotation(Math.PI / 2, 0, 1, 0)), Mat4.scale(1, 5.5, 1), this.shapes.tree3, this.materials.tree3, this.materials.shadow, Mat4.translation(0, 1.5, 1,)),
            new Nature(Mat4.translation(45, 13, -65).times(Mat4.scale(5, 5, 5)).times(Mat4.rotation(Math.PI / 2, 0, 1, 0)), Mat4.scale(1.05, 6, 1), this.shapes.tree4, this.materials.tree4, this.materials.shadow, Mat4.translation(-1.65, 1.3, 1.6)),
            new Nature(Mat4.translation(30, 13, -45).times(Mat4.scale(5, 5, 5)).times(Mat4.rotation(Math.PI / 2, 0, 1, 0)), Mat4.scale(1, 7, 1.2), this.shapes.tree5, this.materials.tree5, this.materials.shadow, Mat4.translation(3, 1, 0.9)),
            new Nature(Mat4.translation(-85, 5, -85).times(Mat4.scale(10, 10, 10)).times(Mat4.rotation(Math.PI / 4, 0, 1, 0)), Mat4.scale(13, 7, 12.5), this.shapes.rock, this.materials.rock, this.materials.shadow, Mat4.translation(0.1, -0.2, -0.05,)),
            new Nature(Mat4.translation(-50, 1, -50).times(Mat4.scale(8, 16, 12)).times(Mat4.rotation(Math.PI / 2, 0, 1, 0)), Mat4.scale(7., 7.8, 9.5), this.shapes.rock, this.materials.rock2, this.materials.shadow, Mat4.translation(-0.1, -0.8, -0.2,)), 
            new Nature(Mat4.translation(-50, 18, -50).times(Mat4.scale(8, 4, 10)).times(Mat4.rotation(Math.PI / 2, 0, 1, 0)), Mat4.scale(8, 2, 9), this.shapes.rock, this.materials.rock2, this.materials.shadow, Mat4.translation(-0.2, 0, -0.2)),
            new Nature(Mat4.translation(0, -0.1, 50), Mat4.scale(0.5, 0.6, 2), this.shapes.log, this.materials.log, this.materials.shadow, Mat4.translation(0, -0.1, -0.4))
        ];
        player = new Player(Mat4.translation(...INITIAL_POSITION), this.nature)

        this.multishot = false;
        this.shootCooldown = 1000;
        this.canShoot = true;

        this.addBalloon = () => {
            this.balloons.push(new Balloon(Mat4.scale(0.7, 0.7, 0.7), Mat4.translation(-100, 0, 0), 2, this.shapes.sphere, this.materials.phong, this.materials.shadow))
        }

        this.spawnBalloons = function() {
            this.addBalloon();
            setTimeout(this.spawnBalloons.bind(this), 1500)
        }

        this.spawnBalloons();

        this.init_ok = false;
    }

    make_control_panel() {
        this.key_triggered_button("Shoot", [" "], () => {
            if (this.canShoot)
            {
                this.canShoot = false;
                let lookDirection = camera_matrix.times(vec4(0, 0, 1, 0));
                if (!this.multishot)
                    this.projectiles.push(new Projectile(Mat4.translation(...origin), Mat4.scale(1/2, 1/2, 1/2), lookDirection.times(50), pitch, yaw, this.shapes.projectile, this.materials.phong, this.materials.shadow));
                else
                {
                    this.projectiles.push(new Projectile(Mat4.translation(...origin), Mat4.scale(1/2, 1/2, 1/2), Mat4.rotation(Math.PI / 12, 0, 1, 0).times(lookDirection).times(50), pitch - Math.PI / 12, yaw, this.shapes.projectile, this.materials.phong, this.materials.shadow));
                    this.projectiles.push(new Projectile(Mat4.translation(...origin), Mat4.scale(1/2, 1/2, 1/2), lookDirection.times(50), pitch, yaw, this.shapes.projectile, this.materials.phong, this.materials.shadow));
                    this.projectiles.push(new Projectile(Mat4.translation(...origin), Mat4.scale(1/2, 1/2, 1/2), Mat4.rotation(-Math.PI / 12, 0, 1, 0).times(lookDirection).times(50), pitch + Math.PI / 12, yaw, this.shapes.projectile, this.materials.phong, this.materials.shadow));
                }
                setTimeout(() => this.canShoot = true, this.shootCooldown);
            }
        })
        this.key_triggered_button("Multishot", ["m"], () => {
            this.multishot = !this.multishot;
        })
        this.key_triggered_button("Supermonkey", ["q"], () => {
            if (this.shootCooldown == 0)
                this.shootCooldown = 1000;
            else
                this.shootCooldown = 0;
        })
    }

    texture_buffer_init(gl) {
        // Depth Texture
        this.lightDepthTexture = gl.createTexture();
        // Bind it to TinyGraphics
        this.light_depth_texture = new Buffered_Texture(this.lightDepthTexture);
        this.materials.terrain.light_depth_texture = this.light_depth_texture

        this.lightDepthTextureSize = LIGHT_DEPTH_TEX_SIZE;
        gl.bindTexture(gl.TEXTURE_2D, this.lightDepthTexture);
        gl.texImage2D(
            gl.TEXTURE_2D,      // target
            0,                  // mip level
            gl.DEPTH_COMPONENT, // internal format
            this.lightDepthTextureSize,   // width
            this.lightDepthTextureSize,   // height
            0,                  // border
            gl.DEPTH_COMPONENT, // format
            gl.UNSIGNED_INT,    // type
            null);              // data
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Depth Texture Buffer
        this.lightDepthFramebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.lightDepthFramebuffer);
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER,       // target
            gl.DEPTH_ATTACHMENT,  // attachment point
            gl.TEXTURE_2D,        // texture target
            this.lightDepthTexture,         // texture
            0);                   // mip level
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // create a color texture of the same size as the depth texture
        // see article why this is needed_
        this.unusedTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.unusedTexture);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            this.lightDepthTextureSize,
            this.lightDepthTextureSize,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            null,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // attach it to the framebuffer
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER,        // target
            gl.COLOR_ATTACHMENT0,  // attachment point
            gl.TEXTURE_2D,         // texture target
            this.unusedTexture,         // texture
            0);                    // mip level
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    render_scene(context, program_state, shadow_pass, draw_light_source=false, draw_shadow=false)
    {
        // shadow_pass: true if this is the second pass that draw the shadow.
        // draw_light_source: true if we want to draw the light source.
        // draw_shadow: true if we want to draw the shadow

        let light_position = this.light_position;
        let light_color = this.light_color;
        const t = program_state.animation_time, dt = program_state.animation_delta_time / 1000;

        program_state.draw_shadow = draw_shadow;

        console.time("Draws light-src")
        if (draw_light_source && shadow_pass) {
            this.shapes.sphere.draw(context, program_state,
                Mat4.translation(light_position[0], light_position[1], light_position[2]).times(Mat4.scale(1,1,1)),
                this.materials.light_src.override({color: hex_color("#FC9601")}));
        }
        console.timeEnd("Draws light-src")

        console.time("Draws projectiles")
        for (let i = 0; i < this.projectiles.length; i++)
        {
            if (this.projectiles[i].collidedObjects.size == 0 && !this.projectiles[i].out_of_bounds)
                this.projectiles[i].draw(context, program_state, dt, shadow_pass)
            else
            {
                this.projectiles.splice(i, 1);
                i--;
            }
        }
        console.timeEnd("Draws projectiles")
        
        console.time("Draws balloons")
        console.log("# Balloons: %d", this.balloons.length)
        for (let i = 0; i < this.balloons.length; i++)
        {
            if (this.balloons[i].collidedObjects.size < this.balloons[i].durability)
                this.balloons[i].draw(context, program_state, dt, this.projectiles, shadow_pass)
            else
            {
                console.time("Balloons Array Splicing")
                this.balloons.splice(i, 1);
                i--;
                console.timeEnd("Balloons Array Splicing")
            }
        } 
        console.timeEnd("Draws balloons")

        console.time("Draws natures")
        this.nature.forEach((nature) => {
            nature.draw(context, program_state, this.projectiles, shadow_pass, this.shapes.bounding_box, this.materials.bound_box)
        })
        console.timeEnd("Draws natures")

        drawTerrain(context, program_state, this.shapes.ground, shadow_pass ? this.materials.terrain : this.materials.pure);
        drawSkybox(context, program_state, this.shapes.square, [this.materials.skybox_top, this.materials.skybox_front, this.materials.skybox_left, this.materials.skybox_right, this.materials.skybox_back], shadow_pass );

        program_state.camera_inverse = Mat4.inverse(Mat4.translation(...origin).times(camera_matrix));

    }
    /*
    display(context, program_state) {
        if (!context.scratchpad.controls) {
            this.children.push(context.scratchpad.controls = new Movement());
            origin = INITIAL_POSITION;
        }

        program_state.projection_transform = Mat4.perspective(
            Math.PI / 4, context.width / context.height, 1, 300);

        const light_position = vec4(20, 100, 20, 1);
        program_state.lights = [new Light(light_position, color(1, 1, 1, 1), 1000000)];

        let t = program_state.animation_time / 1000, dt = program_state.animation_delta_time / 1000;
        let model_transform = Mat4.identity();

        drawTerrain(context, program_state, this.shapes.ground, this.materials.terrain);
        drawSkybox(context, program_state, this.shapes.square, [this.materials.skybox_top, this.materials.skybox_front, this.materials.skybox_left, this.materials.skybox_right, this.materials.skybox_back] );

        for (let i = 0; i < this.projectiles.length; i++)
        {
            if (this.projectiles[i].collidedObjects.size == 0 && !this.projectiles[i].out_of_bounds)
                this.projectiles[i].draw(context, program_state, dt)
            else
            {
                this.projectiles.splice(i, 1);
                i--;
            }
        }
        
        for (let i = 0; i < this.balloons.length; i++)
        {
            if (this.balloons[i].collidedObjects.size < this.balloons[i].durability)
                this.balloons[i].draw(context, program_state, dt, this.projectiles)
            else
            {
                this.balloons.splice(i, 1);
                i--;
            }
        } 

        this.nature.forEach((nature) => {
            nature.draw(context, program_state, this.projectiles)
        })

        program_state.camera_inverse = Mat4.inverse(Mat4.translation(...origin).times(camera_matrix));
    }
    */

    display(context, program_state) {
        console.time("Initialization")

        if (!context.scratchpad.controls) {
            this.children.push(context.scratchpad.controls = new Movement());
            origin = INITIAL_POSITION;
        }

        let t = program_state.animation_time / 1000, dt = program_state.animation_delta_time / 1000;
        const gl = context.context;

        console.log(1 / dt)

        if (!this.init_ok) {
            const ext = gl.getExtension('WEBGL_depth_texture');
            if (!ext) {
                return alert('need WEBGL_depth_texture');  // eslint-disable-line
            }
            this.texture_buffer_init(gl);

            this.init_ok = true;
        }

        // The position of the light
        this.light_position =  Mat4.rotation(t / 50, 0, 1, 0).times(vec4(50, 50, 0, 1));
        // The color of the light
        this.light_color = color(
            0.667 + Math.sin(t/500) / 3,
            0.667 + Math.sin(t/1500) / 3,
            0.667 + Math.sin(t/3500) / 3,
            1
        );

        // This is a rough target of the light.
        // Although the light is point light, we need a target to set the POV of the light
        this.light_view_target = vec4(0, 0, 0, 1);
        this.light_field_of_view = 170 * Math.PI / 180; // 180 degree

        program_state.lights = [new Light(this.light_position, this.light_color, 100000)];

        console.timeEnd("Initialization")


        console.time("Step 1")

        // Step 1: set the perspective and camera to the POV of light
        const light_view_mat = Mat4.look_at(
            vec3(this.light_position[0], this.light_position[1], this.light_position[2]),
            vec3(this.light_view_target[0], this.light_view_target[1], this.light_view_target[2]),
            vec3(0, 1, 0), // assume the light to target will have a up dir of +y, maybe need to change according to your case
        );
        const light_proj_mat = Mat4.perspective(this.light_field_of_view, 1, 0.5, 500);
        // Bind the Depth Texture Buffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.lightDepthFramebuffer);
        gl.viewport(0, 0, this.lightDepthTextureSize, this.lightDepthTextureSize);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        // Prepare uniforms
        program_state.light_view_mat = light_view_mat;
        program_state.light_proj_mat = light_proj_mat;
        program_state.light_tex_mat = light_proj_mat;
        program_state.view_mat = light_view_mat;
        program_state.projection_transform = light_proj_mat;
        this.render_scene(context, program_state, false, false, false);

        console.timeEnd("Step 1")
        console.time("Step 2")

        // Step 2: unbind, draw to the canvas
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        program_state.view_mat = program_state.camera_inverse;
        program_state.projection_transform = Mat4.perspective(Math.PI / 4, context.width / context.height, 0.5, 500);
        this.render_scene(context, program_state, true, true, true);

        console.timeEnd("Step 2")

        /*
        // Step 3: display the textures
        this.shapes.ground.draw(context, program_state,
            Mat4.translation(-.99, .08, 0).times(
            Mat4.scale(0.5, 0.5 * gl.canvas.width / gl.canvas.height, 1)
            ),
            this.depth_tex.override({texture: this.lightDepthTexture})
        );
        */
    }
}

// Modified Phong shader for the tree
// Normally, the Phong shader only allows for a single object color
// For the tree, the shader is modified so that for y-coordinates below the leaves, the tree is colored brown (tree bark)
// and for y-coordinates above the leaves, the tree is colored green
class Tree_Shader extends Shader {
    // **Phong_Shader** is a subclass of Shader, which stores and manages a GPU program.
    // Graphic cards prior to year 2000 had shaders like this one hard-coded into them
    // instead of customizable shaders.  "Phong-Blinn" Shading here is a process of
    // determining brightness of pixels via vector math.  It compares the normal vector
    // at that pixel with the vectors toward the camera and light sources.


    constructor(num_lights = 2) {
        super();
        this.num_lights = num_lights;
    }

    shared_glsl_code() {
        // ********* SHARED CODE, INCLUDED IN BOTH SHADERS *********
        return ` precision mediump float;
            const int N_LIGHTS = ` + this.num_lights + `;
            uniform float ambient, diffusivity, specularity, smoothness;
            uniform vec4 light_positions_or_vectors[N_LIGHTS], light_colors[N_LIGHTS];
            uniform float light_attenuation_factors[N_LIGHTS];
            uniform vec4 shape_color;
            uniform vec4 shape2_color;
            uniform vec3 squared_scale, camera_center;
            uniform float ycutoff;
            varying vec4 point_position;
    
            // Specifier "varying" means a variable's final value will be passed from the vertex shader
            // on to the next phase (fragment shader), then interpolated per-fragment, weighted by the
            // pixel fragment's proximity to each of the 3 vertices (barycentric interpolation).
            varying vec3 N, vertex_worldspace;
            // ***** PHONG SHADING HAPPENS HERE: *****                                       
            vec3 phong_model_lights( vec3 N, vec3 vertex_worldspace, vec3 color){                                        
                // phong_model_lights():  Add up the lights' contributions.
                vec3 E = normalize( camera_center - vertex_worldspace );
                vec3 result = vec3( 0.0 );
                for(int i = 0; i < N_LIGHTS; i++){
                    // Lights store homogeneous coords - either a position or vector.  If w is 0, the 
                    // light will appear directional (uniform direction from all points), and we 
                    // simply obtain a vector towards the light by directly using the stored value.
                    // Otherwise if w is 1 it will appear as a point light -- compute the vector to 
                    // the point light's location from the current surface point.  In either case, 
                    // fade (attenuate) the light as the vector needed to reach it gets longer.  
                    vec3 surface_to_light_vector = light_positions_or_vectors[i].xyz - 
                                                    light_positions_or_vectors[i].w * vertex_worldspace;                                             
                    float distance_to_light = length( surface_to_light_vector );
    
                    vec3 L = normalize( surface_to_light_vector );
                    vec3 H = normalize( L + E );
                    // Compute the diffuse and specular components from the Phong
                    // Reflection Model, using Blinn's "halfway vector" method:
                    float diffuse  =      max( dot( N, L ), 0.0 );
                    float specular = pow( max( dot( N, H ), 0.0 ), smoothness );
                    float attenuation = 1.0 / (1.0 + light_attenuation_factors[i] * distance_to_light * distance_to_light );
                    
                    vec3 light_contribution = color * light_colors[i].xyz * diffusivity * diffuse
                                                                + light_colors[i].xyz * specularity * specular;
                    result += attenuation * light_contribution;
                    }
                return result;
                } `;
    }

    vertex_glsl_code() {
        // ********* VERTEX SHADER *********
        return this.shared_glsl_code() + `
            attribute vec3 position, normal;                            
            // Position is expressed in object coordinates.
            
            uniform mat4 model_transform;
            uniform mat4 projection_camera_model_transform;

            void main(){                                                                   
                // The vertex's final resting place (in NDCS):
                gl_Position = projection_camera_model_transform * vec4( position, 1.0 );
                // The final normal vector in screen space.
                N = normalize( mat3( model_transform ) * normal / squared_scale);
                vertex_worldspace = ( model_transform * vec4( position, 1.0 ) ).xyz;
                point_position = vec4(position, 1.0);
                } `;
    }

    fragment_glsl_code() {
        // ********* FRAGMENT SHADER *********
        // A fragment is a pixel that's overlapped by the current triangle.
        // Fragments affect the final image or get discarded due to depth.
        return this.shared_glsl_code() + `
            void main(){                       
                if (point_position.y >= ycutoff)
                {
                    // Compute an initial (ambient) color:
                    gl_FragColor = vec4( shape_color.xyz * ambient, shape_color.w );
                    // Compute the final color with contributions from lights:
                    gl_FragColor.xyz += phong_model_lights( normalize( N ), vertex_worldspace, vec3(shape_color.xyz) );
                }
                else
                {
                    gl_FragColor = vec4( shape2_color.xyz * ambient, shape2_color.w );
                    gl_FragColor.xyz += phong_model_lights( normalize( N ), vertex_worldspace, vec3(shape2_color.xyz) );
                }
                } `;
    }

    send_material(gl, gpu, material) {
        // send_material(): Send the desired shape-wide material qualities to the
        // graphics card, where they will tweak the Phong lighting formula.
        gl.uniform4fv(gpu.shape_color, material.leaf);
        gl.uniform4fv(gpu.shape2_color, material.stump);
        gl.uniform1f(gpu.ambient, material.ambient);
        gl.uniform1f(gpu.diffusivity, material.diffusivity);
        gl.uniform1f(gpu.specularity, material.specularity);
        gl.uniform1f(gpu.smoothness, material.smoothness);
        gl.uniform1f(gpu.ycutoff, material.ycutoff)
    }

    send_gpu_state(gl, gpu, gpu_state, model_transform) {
        // send_gpu_state():  Send the state of our whole drawing context to the GPU.
        const O = vec4(0, 0, 0, 1), camera_center = gpu_state.camera_transform.times(O).to3();
        gl.uniform3fv(gpu.camera_center, camera_center);
        // Use the squared scale trick from "Eric's blog" instead of inverse transpose matrix:
        const squared_scale = model_transform.reduce(
            (acc, r) => {
                return acc.plus(vec4(...r).times_pairwise(r))
            }, vec4(0, 0, 0, 0)).to3();
        gl.uniform3fv(gpu.squared_scale, squared_scale);
        // Send the current matrices to the shader.  Go ahead and pre-compute
        // the products we'll need of the of the three special matrices and just
        // cache and send those.  They will be the same throughout this draw
        // call, and thus across each instance of the vertex shader.
        // Transpose them since the GPU expects matrices as column-major arrays.
        const PCM = gpu_state.projection_transform.times(gpu_state.camera_inverse).times(model_transform);
        gl.uniformMatrix4fv(gpu.model_transform, false, Matrix.flatten_2D_to_1D(model_transform.transposed()));
        gl.uniformMatrix4fv(gpu.projection_camera_model_transform, false, Matrix.flatten_2D_to_1D(PCM.transposed()));

        // Omitting lights will show only the material color, scaled by the ambient term:
        if (!gpu_state.lights.length)
            return;

        const light_positions_flattened = [], light_colors_flattened = [];
        for (let i = 0; i < 4 * gpu_state.lights.length; i++) {
            light_positions_flattened.push(gpu_state.lights[Math.floor(i / 4)].position[i % 4]);
            light_colors_flattened.push(gpu_state.lights[Math.floor(i / 4)].color[i % 4]);
        }
        gl.uniform4fv(gpu.light_positions_or_vectors, light_positions_flattened);
        gl.uniform4fv(gpu.light_colors, light_colors_flattened);
        gl.uniform1fv(gpu.light_attenuation_factors, gpu_state.lights.map(l => l.attenuation));
    }

    update_GPU(context, gpu_addresses, gpu_state, model_transform, material) {
        // update_GPU(): Define how to synchronize our JavaScript's variables to the GPU's.  This is where the shader
        // recieves ALL of its inputs.  Every value the GPU wants is divided into two categories:  Values that belong
        // to individual objects being drawn (which we call "Material") and values belonging to the whole scene or
        // program (which we call the "Program_State").  Send both a material and a program state to the shaders
        // within this function, one data field at a time, to fully initialize the shader for a draw.

        // Fill in any missing fields in the Material object with custom defaults for this shader:
        const defaults = {color: color(0, 0, 0, 1), ambient: 0, diffusivity: 1, specularity: 1, smoothness: 40};
        material = Object.assign({}, defaults, material);

        this.send_material(context, gpu_addresses, material);
        this.send_gpu_state(context, gpu_addresses, gpu_state, model_transform);
    }
}
