const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/auth.js');

const prisma = new PrismaClient();
const router = express.Router();

router.use(authMiddleware);

// GET /api/issues - Retrieve issues with filtering
router.get('/', async (req, res) => {
    console.log('1. Received request for GET /api/issues');
    const { projectId, status, priority, search } = req.query;
    const userId = req.user.id;
    const where = {};

    if (projectId) where.projectId = projectId;
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (search) {
        where.title = {
            contains: search,
            mode: 'insensitive',
        };
    }
    
    // Filter to show issues assigned to current user or in their projects
    where.OR = [
        { project: { ownerId: userId } }, // Issues in user's projects
        { assignees: { some: { userId: userId } } } // Issues assigned to user
    ];
    
    console.log('2. Built filter object:', where);

    try {
        console.log('3. Querying the database...');
        const issues = await prisma.issue.findMany({
            where,
            include: {
                project: { select: { name: true } },
                assignees: {
                    include: {
                        user: { select: { id: true, name: true, email: true } }
                    }
                }
            },
            orderBy: { createdAt: 'desc' },
        });
        console.log('4. Database query successful! Sending response.');
        res.status(200).json(issues);
    } catch (error) {
        console.error('5. An error occurred in the database query!', error);
        res.status(500).json({ message: 'Failed to retrieve issues.', error: error.message });
    }
});

// POST /api/issues - Create a new issue with multiple assignees
router.post('/', async (req, res) => {
    const { title, description, priority, projectId, assigneeIds } = req.body;
    const currentUserId = req.user.id;

    if (!title || !projectId) {
        return res.status(400).json({ message: 'Title and projectId are required.' });
    }

    try {
        // Validate project ownership
        const project = await prisma.project.findUnique({
            where: { id: projectId }
        });

        if (!project) {
            return res.status(404).json({ message: 'Project not found.' });
        }

        if (project.ownerId !== currentUserId) {
            return res.status(403).json({ message: 'Only project owner can create issues.' });
        }

        // Create issue data
        const issueData = { 
            title, 
            description, 
            priority: priority || 'medium',
            projectId
        };

        // Add assignees if provided
        if (assigneeIds && Array.isArray(assigneeIds) && assigneeIds.length > 0) {
            issueData.assignees = {
                create: assigneeIds.map(userId => ({ userId }))
            };
        }

        const newIssue = await prisma.issue.create({
            data: issueData,
            include: {
                project: { select: { name: true } },
                assignees: {
                    include: {
                        user: { select: { id: true, name: true, email: true } }
                    }
                }
            }
        });
        
        // ✨ EMIT EVENT: A new issue has been created
        req.io.emit('issue:created', newIssue);

        res.status(201).json(newIssue);
    } catch (error) {
        console.error('Create issue error:', error);
        res.status(500).json({ message: 'Failed to create issue.', error: error.message });
    }
});

// PATCH /api/issues/:issueId - Update an issue
router.patch('/:issueId', async (req, res) => {
    const { issueId } = req.params;
    const { title, description, status, priority, assigneeIds } = req.body;
    const currentUserId = req.user.id;

    try {
        // Validate project ownership
        const issue = await prisma.issue.findUnique({
            where: { id: issueId },
            include: { project: true }
        });

        if (!issue) {
            return res.status(404).json({ message: 'Issue not found.' });
        }

        if (issue.project.ownerId !== currentUserId) {
            return res.status(403).json({ message: 'Only project owner can update issues.' });
        }

        // Base update data
        const updateData = {};
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (status !== undefined) updateData.status = status;
        if (priority !== undefined) updateData.priority = priority;
        
        // If assigneeIds is provided, update assignees
        if (assigneeIds !== undefined) {
            // First, remove existing assignees
            await prisma.issueAssignee.deleteMany({
                where: { issueId }
            });
            
            // Then add new assignees if any
            if (Array.isArray(assigneeIds) && assigneeIds.length > 0) {
                updateData.assignees = {
                    create: assigneeIds.map(userId => ({ userId }))
                };
            }
        }

        const updatedIssue = await prisma.issue.update({
            where: { id: issueId },
            data: updateData,
            include: {
                project: { select: { name: true } },
                assignees: {
                    include: {
                        user: { select: { id: true, name: true, email: true } }
                    }
                }
            }
        });

        // ✨ EMIT EVENT: An existing issue has been updated
        req.io.emit('issue:updated', updatedIssue);

        res.status(200).json(updatedIssue);
    } catch (error) {
        console.error('Update issue error:', error);
        if (error.code === 'P2025') {
            return res.status(404).json({ message: 'Issue not found.' });
        }
        res.status(500).json({ message: 'Failed to update issue.', error: error.message });
    }
});

// POST /api/issues/:issueId/assign - Add assignees to issue
router.post('/:issueId/assign', async (req, res) => {
    const { issueId } = req.params;
    const { userIds } = req.body;
    const currentUserId = req.user.id;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ message: 'userIds array is required.' });
    }

    try {
        // Check if user owns the project
        const issue = await prisma.issue.findUnique({
            where: { id: issueId },
            include: { project: true }
        });

        if (!issue) {
            return res.status(404).json({ message: 'Issue not found.' });
        }

        if (issue.project.ownerId !== currentUserId) {
            return res.status(403).json({ message: 'Only project owner can assign users.' });
        }

        // Add new assignees (ignore duplicates due to unique constraint)
        const assignPromises = userIds.map(async (userId) => {
            try {
                return await prisma.issueAssignee.create({
                    data: { issueId, userId }
                });
            } catch (error) {
                // Ignore duplicate key errors (P2002)
                if (error.code === 'P2002') {
                    console.log(`User ${userId} already assigned to issue ${issueId}`);
                    return null;
                }
                throw error;
            }
        });

        await Promise.all(assignPromises);

        // Get updated issue
        const updatedIssue = await prisma.issue.findUnique({
            where: { id: issueId },
            include: {
                project: { select: { name: true } },
                assignees: {
                    include: {
                        user: { select: { id: true, name: true, email: true } }
                    }
                }
            }
        });

        req.io.emit('issue:assigned', updatedIssue);

        res.status(200).json({
            message: 'Users assigned successfully',
            issue: updatedIssue
        });
    } catch (error) {
        console.error('Assign users error:', error);
        res.status(500).json({ message: 'Failed to assign users.' });
    }
});

// POST /api/issues/:issueId/unassign - Remove assignees from issue
router.post('/:issueId/unassign', async (req, res) => {
    const { issueId } = req.params;
    const { userIds } = req.body;
    const currentUserId = req.user.id;

    try {
        // Check if user owns the project
        const issue = await prisma.issue.findUnique({
            where: { id: issueId },
            include: { 
                project: true,
                assignees: {
                    include: {
                        user: { select: { name: true, email: true } }
                    }
                }
            }
        });

        if (!issue) {
            return res.status(404).json({ message: 'Issue not found.' });
        }

        if (issue.project.ownerId !== currentUserId) {
            return res.status(403).json({ message: 'Only project owner can unassign users.' });
        }

        let whereCondition;
        if (userIds && Array.isArray(userIds) && userIds.length > 0) {
            // Unassign specific users
            whereCondition = { issueId, userId: { in: userIds } };
        } else {
            // Unassign all users
            whereCondition = { issueId };
        }

        const removedAssignees = await prisma.issueAssignee.findMany({
            where: whereCondition,
            include: {
                user: { select: { name: true, email: true } }
            }
        });

        await prisma.issueAssignee.deleteMany({
            where: whereCondition
        });

        // Get updated issue
        const updatedIssue = await prisma.issue.findUnique({
            where: { id: issueId },
            include: {
                project: { select: { name: true } },
                assignees: {
                    include: {
                        user: { select: { id: true, name: true, email: true } }
                    }
                }
            }
        });

        req.io.emit('issue:unassigned', { 
            issueId,
            projectId: issue.projectId,
            removedAssignees: removedAssignees.map(a => a.user)
        });

        res.status(200).json({
            message: 'Users unassigned successfully',
            issue: updatedIssue,
            removedAssignees: removedAssignees.map(a => a.user)
        });
    } catch (error) {
        console.error('Unassign users error:', error);
        res.status(500).json({ message: 'Failed to unassign users.' });
    }
});

// DELETE /api/issues/:issueId - Delete an issue
router.delete('/:issueId', async (req, res) => {
    const { issueId } = req.params;
    const currentUserId = req.user.id;

    try {
        // Validate project ownership before deletion
        const issue = await prisma.issue.findUnique({
            where: { id: issueId },
            include: { project: true }
        });

        if (!issue) {
            return res.status(404).json({ message: 'Issue not found.' });
        }

        if (issue.project.ownerId !== currentUserId) {
            return res.status(403).json({ message: 'Only project owner can delete issues.' });
        }

        await prisma.issue.delete({
            where: { id: issueId },
        });

        // ✨ EMIT EVENT: An issue has been deleted
        req.io.emit('issue:deleted', { id: issueId });

        res.status(204).send();
    } catch (error) {
        console.error('Delete issue error:', error);
        if (error.code === 'P2025') {
            return res.status(404).json({ message: 'Issue not found.' });
        }
        res.status(500).json({ message: 'Failed to delete issue.', error: error.message });
    }
});

module.exports = router;
