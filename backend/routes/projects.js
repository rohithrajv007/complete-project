const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/auth.js');

const prisma = new PrismaClient();
const router = express.Router();

// Apply the auth middleware to all routes in this file
router.use(authMiddleware);

// --- EXISTING ROUTES ---

// GET /api/projects - Get all projects for the logged-in user (owned + assigned)
router.get('/', async (req, res) => {
    const userId = req.user.id;

    try {
        const projects = await prisma.project.findMany({
            where: {
                OR: [
                    { ownerId: userId }, // Projects they own
                    { 
                        issues: {
                            some: {
                                assignees: {
                                    some: {
                                        userId: userId // Projects where they have assigned issues (NEW SCHEMA)
                                    }
                                }
                            }
                        }
                    },
                    { 
                        collaborators: {
                            some: {
                                userId: userId // ✅ Projects where they are collaborators
                            }
                        }
                    }
                ]
            },
            include: {
                owner: {
                    select: { name: true, email: true } // Show project owner info
                },
                collaborators: { // ✅ Include collaborators
                    include: {
                        user: {
                            select: { id: true, name: true, email: true }
                        }
                    }
                },
                issues: {
                    where: { 
                        assignees: {
                            some: { userId: userId } // Only show issues assigned to current user (NEW SCHEMA)
                        }
                    },
                    select: { 
                        id: true, 
                        title: true, 
                        status: true, 
                        priority: true,
                        assignees: {
                            select: {
                                user: {
                                    select: { id: true, name: true, email: true }
                                }
                            }
                        }
                    }
                },
                _count: {
                    select: { issues: true } // Total issue count in project
                }
            },
            orderBy: { createdAt: 'desc' },
        });

        // Add role information to each project
        const projectsWithRole = projects.map(project => ({
            ...project,
            userRole: project.ownerId === userId ? 'owner' : 'collaborator',
            assignedIssuesCount: project.issues.length
        }));

        res.status(200).json(projectsWithRole);
    } catch (error) {
        console.error('Get projects error:', error);
        res.status(500).json({ message: 'Failed to retrieve projects.' });
    }
});

// POST /api/projects - Create a new project
router.post('/', async (req, res) => {
    const { name, collaboratorIds } = req.body; // ✅ Added collaboratorIds support
    const userId = req.user.id;

    if (!name) {
        return res.status(400).json({ message: 'Project name is required.' });
    }

    try {
        // Create project with optional collaborators
        const newProject = await prisma.project.create({
            data: {
                name,
                ownerId: userId,
                ...(collaboratorIds && collaboratorIds.length > 0 && {
                    collaborators: {
                        create: collaboratorIds.map(id => ({
                            userId: id
                        }))
                    }
                })
            },
            include: {
                owner: {
                    select: { name: true, email: true }
                },
                collaborators: { // ✅ Include collaborators in response
                    include: {
                        user: {
                            select: { id: true, name: true, email: true }
                        }
                    }
                },
                _count: {
                    select: { issues: true }
                }
            }
        });

        // Add role information for consistency with GET response
        const projectWithRole = {
            ...newProject,
            userRole: 'owner',
            assignedIssuesCount: 0,
            issues: []
        };

        console.log(`Project created: ${name} with ${collaboratorIds?.length || 0} collaborators`);
        res.status(201).json(projectWithRole);
    } catch (error) {
        console.error('Create project error:', error);
        res.status(500).json({ message: 'Failed to create project.' });
    }
});

// ===============================================
// ✅ NEW PROJECT COLLABORATION ENDPOINTS
// ===============================================

// DELETE /api/projects/:id - Delete a project (owner only)
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
        // Check if user owns the project
        const project = await prisma.project.findFirst({
            where: {
                id: id,
                ownerId: userId
            }
        });

        if (!project) {
            return res.status(404).json({ message: 'Project not found or access denied (owner only)' });
        }

        // Delete project (cascades to issues, assignments, and collaborators)
        await prisma.project.delete({
            where: { id: id }
        });

        console.log(`Project deleted: ${id} by user: ${userId}`);
        res.json({ message: 'Project deleted successfully' });
    } catch (error) {
        console.error('Delete project error:', error);
        res.status(500).json({ message: 'Failed to delete project' });
    }
});

// POST /api/projects/:id/assign - Assign users to project (make them collaborators)
router.post('/:id/assign', async (req, res) => {
    try {
        const { id } = req.params;
        const { userIds } = req.body;
        const userId = req.user.id;

        if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
            return res.status(400).json({ message: 'User IDs array is required' });
        }

        // Check if user owns the project or is already a collaborator
        const project = await prisma.project.findFirst({
            where: {
                id: id,
                OR: [
                    { ownerId: userId },
                    { 
                        collaborators: {
                            some: { userId: userId }
                        }
                    }
                ]
            }
        });

        if (!project) {
            return res.status(404).json({ message: 'Project not found or access denied' });
        }

        // Add collaborators (avoid duplicates)
        const collaboratorData = userIds.map(uid => ({
            projectId: id,
            userId: uid
        }));

        await prisma.projectCollaborator.createMany({
            data: collaboratorData,
            skipDuplicates: true
        });

        // Return updated project with collaborators
        const updatedProject = await prisma.project.findUnique({
            where: { id: id },
            include: {
                owner: {
                    select: { name: true, email: true }
                },
                collaborators: {
                    include: {
                        user: {
                            select: { id: true, name: true, email: true }
                        }
                    }
                },
                _count: {
                    select: { issues: true }
                }
            }
        });

        console.log(`Added ${userIds.length} collaborators to project: ${id}`);
        res.json(updatedProject);
    } catch (error) {
        console.error('Assign users to project error:', error);
        res.status(500).json({ message: 'Failed to assign users to project' });
    }
});

// POST /api/projects/:id/unassign - Remove users from project
router.post('/:id/unassign', async (req, res) => {
    try {
        const { id } = req.params;
        const { userIds } = req.body;
        const userId = req.user.id;

        if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
            return res.status(400).json({ message: 'User IDs array is required' });
        }

        // Check if user owns the project (only owners can remove collaborators)
        const project = await prisma.project.findFirst({
            where: {
                id: id,
                ownerId: userId
            }
        });

        if (!project) {
            return res.status(404).json({ message: 'Project not found or access denied (owner only)' });
        }

        // Remove collaborators
        await prisma.projectCollaborator.deleteMany({
            where: {
                projectId: id,
                userId: { in: userIds }
            }
        });

        console.log(`Removed ${userIds.length} collaborators from project: ${id}`);
        res.json({ message: 'Users removed from project successfully' });
    } catch (error) {
        console.error('Remove users from project error:', error);
        res.status(500).json({ message: 'Failed to remove users from project' });
    }
});

// GET /api/projects/:id/collaborators - Get project collaborators
router.get('/:id/collaborators', async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        // Check if user has access to this project
        const project = await prisma.project.findFirst({
            where: {
                id: id,
                OR: [
                    { ownerId: userId },
                    { 
                        collaborators: {
                            some: { userId: userId }
                        }
                    }
                ]
            }
        });

        if (!project) {
            return res.status(404).json({ message: 'Project not found or access denied' });
        }

        const collaborators = await prisma.projectCollaborator.findMany({
            where: { projectId: id },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        createdAt: true
                    }
                }
            }
        });

        const collaboratorUsers = collaborators.map(c => c.user);
        console.log(`Retrieved ${collaboratorUsers.length} collaborators for project: ${id}`);
        res.json(collaboratorUsers);
    } catch (error) {
        console.error('Get project collaborators error:', error);
        res.status(500).json({ message: 'Failed to get project collaborators' });
    }
});

// GET /api/projects/:id - Get single project details
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const project = await prisma.project.findFirst({
            where: {
                id: id,
                OR: [
                    { ownerId: userId },
                    { 
                        collaborators: {
                            some: { userId: userId }
                        }
                    }
                ]
            },
            include: {
                owner: {
                    select: { name: true, email: true }
                },
                collaborators: {
                    include: {
                        user: {
                            select: { id: true, name: true, email: true }
                        }
                    }
                },
                issues: {
                    include: {
                        assignees: {
                            include: {
                                user: {
                                    select: { id: true, name: true, email: true }
                                }
                            }
                        }
                    }
                },
                _count: {
                    select: { issues: true }
                }
            }
        });

        if (!project) {
            return res.status(404).json({ message: 'Project not found or access denied' });
        }

        const projectWithRole = {
            ...project,
            userRole: project.ownerId === userId ? 'owner' : 'collaborator'
        };

        console.log(`Retrieved project details: ${id}`);
        res.json(projectWithRole);
    } catch (error) {
        console.error('Get project details error:', error);
        res.status(500).json({ message: 'Failed to get project details' });
    }
});

module.exports = router;
