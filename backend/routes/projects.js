const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/auth.js');

const prisma = new PrismaClient();
const router = express.Router();

// Apply the auth middleware to all routes in this file
router.use(authMiddleware);

// --- ROUTES ---

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
                    }
                ]
            },
            include: {
                owner: {
                    select: { name: true, email: true } // Show project owner info
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
    const { name } = req.body;
    const userId = req.user.id;

    if (!name) {
        return res.status(400).json({ message: 'Project name is required.' });
    }

    try {
        const newProject = await prisma.project.create({
            data: {
                name,
                ownerId: userId,
            },
            include: {
                owner: {
                    select: { name: true, email: true }
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

        res.status(201).json(projectWithRole);
    } catch (error) {
        console.error('Create project error:', error);
        res.status(500).json({ message: 'Failed to create project.' });
    }
});

module.exports = router;
